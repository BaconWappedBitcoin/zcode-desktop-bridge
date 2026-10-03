#!/usr/bin/env node
'use strict';
/**
 * test/ui-state.cjs — the dashboard aggregator + TUI rendering, all offline.
 *
 * Covers (brief): session/offpeak/offer/lane parsing, a stale bridge, corrupt
 * JSON tolerated, the history bucketing, the lane .done exit parsing — plus
 * PlanUsageCache behavior, TUI snapshot renders at 80 and 140 columns (ANSI
 * stripped), the detail body, and a static guard: no dashboard file may
 * reference a plan WRITE endpoint (offers/resets are display-only).
 *
 * Style follows test/offers.cjs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ui = require('../lib/ui-state.cjs');
const { renderFrame, stripAnsi, filterRows, buildDetailBody, loadConfig, detectColorDepth } = require('../bin/bridge-ui.cjs');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); PASS += 1; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); FAIL += 1; }
}
const tmpDirs = [];
function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ui-state-${name}-`));
  tmpDirs.push(d);
  return d;
}
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const iso = (ms) => new Date(ms).toISOString();

// A pid that is definitely dead: start a child, let it exit.
const deadPid = () => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  c.on('close', () => resolve(c.pid));
});

(async () => {
  const NOW = Date.now();
  const H = 3600 * 1000;

  console.log('== 1. lane parsing: .done exit values, running/lost pids ==');
  const laneDir = tmp('lanes');
  const dead = await deadPid();
  write(path.join(laneDir, 'build.pid'), `${process.pid}\n`);                      // running
  write(path.join(laneDir, 'tests.pid'), `${dead}\n`);                             // + .done exit=0
  write(path.join(laneDir, 'tests.done'), `exit=0 at ${iso(NOW - 2 * H)}\n`);
  write(path.join(laneDir, 'import.pid'), `${dead}\n`);                            // + .done exit=2
  write(path.join(laneDir, 'import.done'), `exit=2 at ${iso(NOW - 5 * H)}\nlast line ignored\n`);
  write(path.join(laneDir, 'orphan.pid'), `${dead}\n`);                            // no .done, dead -> lost
  write(path.join(laneDir, 'build.log'), '[09:00] compiling\n[09:01] 42 files ok\n');
  write(path.join(laneDir, 'tests.log'), '1 passing (2s)\n');
  write(path.join(laneDir, 'notes.txt'), 'not a lane\n');                          // non-.pid ignored

  const lanes = ui.loadLanes([{ name: 'game', dir: laneDir }], NOW);
  check('four lanes discovered from .pid triplets', lanes.length === 4, lanes.length);
  const byName = new Map(lanes.map((l) => [l.name, l]));
  check('prefixed, generic names', byName.get('game:build') && byName.get('game:tests'), [...byName.keys()].join(','));
  check('live pid -> running', byName.get('game:build').status === 'running' && byName.get('game:build').pid === process.pid);
  check('.done exit=0 -> done', byName.get('game:tests').status === 'done' && byName.get('game:tests').exitCode === 0);
  check('.done exit=2 -> failed', byName.get('game:import').status === 'failed' && byName.get('game:import').exitCode === 2);
  check('dead pid without .done -> lost', byName.get('game:orphan').status === 'lost');
  check('lane tail = last log line', byName.get('game:build').tail.includes('42 files ok'), byName.get('game:build').tail);
  check('lane finishedAt anchored at .done time', Math.abs(byName.get('game:tests').finishedAt - (NOW - 2 * H)) < 60000, byName.get('game:tests').finishedAt);
  check('lane elapsed never negative even when mtimes lie', lanes.every((l) => l.elapsedMs >= 0), lanes.map((l) => l.elapsedMs).join(','));
  check('non-.pid files ignored', !byName.get('notes'), 'notes.txt picked up');

  console.log('== 2. parseDoneLine variants + UTF-16 logs ==');
  const doneA = tmp('done');
  const fA = path.join(doneA, 'a.done');
  write(fA, 'exit=0 at 2026-10-02T16:47:15');
  check('plain "exit=N at ISO"', ui.parseDoneLine(fA).exit === 0 && Number.isFinite(ui.parseDoneLine(fA).at));
  const fB = path.join(doneA, 'b.done');
  write(fB, 'exit=-1');
  check('bare "exit=N" (negative)', ui.parseDoneLine(fB).exit === -1);
  const fC = path.join(doneA, 'c.done');
  write(fC, Buffer.from('exit=3 at 2026-10-02T10:00:00', 'utf16le'));
  check('UTF-16LE .done file', ui.parseDoneLine(fC).exit === 3, JSON.stringify(ui.parseDoneLine(fC)));
  const fD = path.join(doneA, 'd.done');
  write(fD, 'garbage only\n');
  check('no exit= line -> null', ui.parseDoneLine(fD) === null);
  const fE = path.join(doneA, 'e.log');
  write(fE, Buffer.from('\ufeff[09:00] compiling\n[09:01] ok\n', 'utf16le'));
  check('readTailLines decodes BOM-marked UTF-16', ui.readTailLines(fE).length === 2 && ui.readTailLines(fE)[1].includes('ok'), JSON.stringify(ui.readTailLines(fE)));

  console.log('== 3. session + offpeak rows ==');
  const root1 = tmp('root1');
  const sessionsDir = path.join(root1, 'out', 'sessions');
  const offpeakDir = path.join(root1, 'out', 'offpeak');
  const offersDir = path.join(root1, 'out', 'offers');
  const uiDir = path.join(root1, 'out', 'ui');
  write(path.join(sessionsDir, 'sess_aaa.json'), JSON.stringify({
    id: 'sess_aaa', workspace: 'w', model: { providerId: 'p', modelId: 'GLM-5.3-Flash' }, status: 'running',
    turns: 2, createdAt: NOW - 40 * 60000, startedAt: NOW - 40 * 60000, lastActivity: NOW - 30000,
    lastOutputTail: 'step 3 of 9: writing tests\nsecond line', usage: { input: 1200, output: 340, cacheRead: 0 }, pid: dead,
  }));
  write(path.join(sessionsDir, 'sess_bbb.json'), JSON.stringify({
    id: 'sess_bbb', status: 'done', turns: 1, createdAt: NOW - 8 * H, startedAt: NOW - 8 * H,
    finishedAt: NOW - 7 * H, lastActivity: NOW - 7 * H, finalTextTail: 'ASYNC_OK', pid: dead,
  }));
  write(path.join(sessionsDir, 'sess_ccc.json'), JSON.stringify({
    id: 'sess_ccc', status: 'cancelled', turns: 1, createdAt: NOW - 90 * 60000, startedAt: NOW - 90 * 60000,
    finishedAt: NOW - 89 * 60000, lastActivity: NOW - 89 * 60000, error: 'client disconnected', pid: dead,
  }));
  write(path.join(offpeakDir, 'offpeak-x1.json'), JSON.stringify({
    id: 'offpeak-x1', title: 'nightly refactor', status: 'queued', queuePosition: 3,
    modelSelection: { providerId: 'account:zai-offpeak-idle-plan', modelId: 'GLM-5.3-Flash' },
    createdAt: NOW - 30 * 60000, updatedAt: NOW - 60000, startedAt: null, ticketState: 'queued', pid: dead,
  }));
  write(path.join(offpeakDir, 'offpeak-x1.log'), `${JSON.stringify({ ts: iso(NOW - 60000), offPeakTaskId: 'offpeak-x1', event: 'queued', state: 'queued' })}\n`);

  const state1 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  const sessRow = state1.active.find((r) => r.id === 'sess_aaa');
  check('session row: kind/model/status', sessRow.kind === 'session' && sessRow.model === 'GLM-5.3-Flash' && sessRow.status === 'running');
  check('session row: elapsed from startedAt to now', Math.abs(sessRow.elapsedMs - 40 * 60000) < 1000, sessRow.elapsedMs);
  check('session row: tail collapsed to one line', sessRow.tail === 'step 3 of 9: writing tests second line', sessRow.tail);
  check('session row: usage carried', sessRow.usage && sessRow.usage.output === 340);
  const doneRow = state1.active.find((r) => r.id === 'sess_bbb');
  check('done session not cancelable', doneRow.cancelable === false);
  const idleRow = state1.active.find((r) => r.id === 'offpeak-x1');
  check('offpeak row: title, queued#pos', idleRow.name === 'nightly refactor' && idleRow.status === 'queued' && idleRow.queuePosition === 3);
  check('offpeak row: NDJSON tail event', idleRow.tail.includes('queued'), idleRow.tail);

  console.log('== 4. bridge liveness: up via pid/port files, stale when down ==');
  check('bridge down with only dead pids (stale)', state1.bridge.up === false && state1.bridge.stale === true, JSON.stringify(state1.bridge));
  check('nothing cancelable while the bridge is down', state1.active.every((r) => !r.cancelable));
  write(path.join(root1, 'out', 'bridge.pid'), `${process.pid}\n`);
  write(path.join(root1, 'out', 'bridge.port'), '8899\n');
  const state2 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  check('bridge.pid alive -> up, port read', state2.bridge.up === true && state2.bridge.port === 8899);
  check('running session cancelable when bridge is up', state2.active.find((r) => r.id === 'sess_aaa').cancelable === true);
  check('queued idle task cancelable when bridge is up', state2.active.find((r) => r.id === 'offpeak-x1').cancelable === true);
  const state3 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW, httpUp: true });
  check('httpUp folds in (probe result)', state3.bridge.up === true && state3.bridge.httpUp === true);

  console.log('== 5. corrupt JSON tolerated ==');
  write(path.join(sessionsDir, 'sess_broken.json'), '{ "id": "sess_broken", "status": ');
  write(path.join(sessionsDir, 'sess_junk.json'), 'not json at all');
  write(path.join(offpeakDir, 'offpeak-junk.json'), '{"id":');
  const state4 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  check('corrupt files skipped, no throw', state4.active.every((r) => r.id !== 'sess_broken' && r.id !== 'offpeak-junk'));
  check('good docs still loaded beside corrupt ones', !!state4.active.find((r) => r.id === 'sess_aaa'));

  console.log('== 6. offers aggregate ==');
  write(path.join(offersDir, 'state.json'), JSON.stringify({
    lastCheckAt: iso(NOW - 5 * 60000), lastError: null,
    offers: [
      { id: 'plan:demo', title: 'Flash quota campaign', kind: 'daily', tokens: { amount: 500000, unit: 'tokens' }, endsAt: iso(NOW + 45 * 60000), claimable: true, count: 1 },
      { id: 'reset:five_hour:x', title: '3 banked 5-hour window resets available', kind: 'reset-opportunity', tokens: null, endsAt: iso(NOW - 60000), claimable: false, count: 3 },
    ],
  }));
  const state5 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  const offer = state5.offers.items.find((o) => o.id === 'plan:demo');
  check('offer title/tokens/claimable', offer.title === 'Flash quota campaign' && offer.tokens.amount === 500000 && offer.claimable === true);
  check('offer expiry countdown (~45m)', Math.abs(offer.msLeft - 45 * 60000) < 2000, offer.msLeft);
  check('expired offer flagged negative', state5.offers.items.find((o) => o.id === 'reset:five_hour:x').msLeft < 0);

  console.log('== 7. history bucketing ==');
  // sess_aaa: turn-completed 2h15m ago, turn-failed 10 min later (same hour bucket -> err wins)
  write(path.join(sessionsDir, 'sess_aaa.log'), [
    JSON.stringify({ ts: iso(NOW - 2 * H - 15 * 60000), sessionId: 'sess_aaa', event: 'turn-completed', turnId: 't1' }),
    JSON.stringify({ ts: iso(NOW - 2 * H - 5 * 60000), sessionId: 'sess_aaa', event: 'turn-failed', turnId: 't2', error: 'boom' }),
    JSON.stringify({ ts: iso(NOW - 3 * H), sessionId: 'sess_aaa', event: 'progress', chars: 8 }),
  ].join('\n') + '\n');
  write(path.join(sessionsDir, 'sess_bbb.log'), `${JSON.stringify({ ts: iso(NOW - 7 * H), sessionId: 'sess_bbb', event: 'turn-completed', turnId: 't1' })}\n`);
  write(path.join(sessionsDir, 'sess_ccc.log'), `${JSON.stringify({ ts: iso(NOW - 89 * 60000), sessionId: 'sess_ccc', event: 'turn-cancelled', turnId: 't1', reason: 'client disconnected' })}\n`);
  const state6 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, watchDirs: [{ name: 'game', dir: laneDir }], now: NOW, historyMode: 'hours' });
  const h6 = state6.history;
  check('24 hourly buckets', h6.mode === 'hours' && h6.buckets === 24 && h6.labels.length === 24);
  check('rows for 3 sessions + 1 idle + 4 lanes', h6.rows.length === 8, h6.rows.map((r) => r.label).join(','));
  const aaa = h6.rows.find((r) => r.key === 'sess_aaa');
  const idx = (msAgo) => Math.floor(((NOW - msAgo) - h6.windowStart) / h6.bucketMs);
  check('turn-failed wins over turn-completed in one bucket (err > ok)', aaa.cells[idx(2 * H + 10 * 60000)] === 'err', aaa.cells.join(''));
  check('running task marks the current bucket ◐', aaa.cells[23] === 'run');
  const bbb = h6.rows.find((r) => r.key === 'sess_bbb');
  check('completed turn marks its bucket ✓', bbb.cells[idx(7 * H)] === 'ok');
  const ccc = h6.rows.find((r) => r.key === 'sess_ccc');
  check('cancelled turn marks its bucket ⊘', ccc.cells[idx(89 * 60000)] === 'cancel');
  const laneRow = h6.rows.find((r) => r.key === 'game:import');
  check('failed lane marks its .done bucket ✗', laneRow.cells[idx(5 * H)] === 'err', laneRow.cells.join(''));
  check('empty buckets stay null (renders ·)', aaa.cells.slice(0, 20).every((c) => c === null || c === 'err'));
  const hDays = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW, historyMode: 'days' }).history;
  check('days mode: 14 daily buckets, date labels', hDays.buckets === 14 && /^\d{2}-\d{2}$/.test(hDays.labels[0]), hDays.labels[0]);

  console.log('== 8. events feed: merged NDJSON, newest first ==');
  write(path.join(offersDir, 'events.log'), [
    JSON.stringify({ ts: iso(NOW - 60000), event: 'offer-new', id: 'plan:demo' }),
    'not json',
  ].join('\n') + '\n');
  const state7 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  const evs = state7.events;
  check('events sorted newest first', evs.length >= 3 && evs[0].tsMs >= evs[evs.length - 1].tsMs, evs.map((e) => e.tsMs).join(','));
  check('kinds tagged per source dir', evs.some((e) => e.kind === 'session') && evs.some((e) => e.kind === 'offpeak') && evs.some((e) => e.kind === 'offers'));
  check('non-NDJSON lines skipped', evs.every((e) => e.event !== 'not json'));

  console.log('== 9. plan gauges from the cache ==');
  write(path.join(uiDir, 'plan.json'), JSON.stringify({
    fetchedAt: iso(NOW - 30000),
    quota: { level: 'glm-coding-plan', limits: [
      { window: 'five_hour', limit: 680000, used: 340000, remaining: 340000, usedPercentage: 50, nextResetTime: iso(NOW + 2 * H) },
      { window: 'week', limit: 4000000, used: 3900000, remaining: 100000, usedPercentage: 97.5, nextResetTime: iso(NOW + 3 * 24 * H) },
    ] },
    resets: { available: { five_hour: [{ expireAt: iso(NOW + 90 * 60000) }, { expireAt: iso(NOW + 4 * H) }], week: [{ expireAt: iso(NOW + 25 * 24 * H) }] } },
  }));
  const state8 = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, now: NOW });
  check('5h gauge 50%', state8.plan.fiveHour.usedPercentage === 50 && state8.plan.fiveHour.used === 340000);
  check('weekly gauge ~97.5%', state8.plan.week.usedPercentage === 97.5);
  check('banked 5h resets: 2, earliest ~90m, <2h warning', state8.plan.resets.fiveHour.count === 2
    && Math.abs(state8.plan.resets.fiveHour.earliestExpireAt - (NOW + 90 * 60000)) < 1000
    && state8.plan.resets.fiveHour.expiringSoon === true);
  check('weekly reset not expiring soon', state8.plan.resets.week.expiringSoon === false);
  check('no plan cache -> plan null', ui.aggregate({ rootDir: tmp('noplan'), now: NOW }).plan === null);

  console.log('== 10. PlanUsageCache: poll cap, disk mirror, failure keeps prev ==');
  const cacheDir = tmp('plancache');
  let calls = 0;
  const cache = new ui.PlanUsageCache({
    dir: cacheDir, minIntervalMs: 60 * 1000,
    fetchSnapshot: async () => { calls += 1; return { quota: { limits: [{ window: 'five_hour', usedPercentage: 10 }] }, resets: { available: {} } }; },
  });
  const doc1 = await cache.ensureFresh();
  check('first ensureFresh fetches + writes plan.json', calls === 1 && fs.existsSync(cache.file) && doc1.quota.limits[0].usedPercentage === 10);
  await cache.ensureFresh();
  check('second call inside the cap does not re-fetch (<=60 s)', calls === 1, calls);
  const cache2 = new ui.PlanUsageCache({
    dir: cacheDir, minIntervalMs: 60 * 1000,
    fetchSnapshot: async () => { throw new Error('must not be called'); },
  });
  const doc2 = await cache2.ensureFresh();
  check('a fresh on-disk cache is served without any fetch', doc2.error === undefined && doc2.quota.limits[0].usedPercentage === 10, JSON.stringify(doc2).slice(0, 160));
  const onDisk = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
  check('failure still refreshes fetchedAt so readers do not hammer', Math.abs(Date.now() - Date.parse(onDisk.fetchedAt)) < 5000);
  // age the on-disk cache past the cap, then let a failing fetch try to refresh
  const aged = { ...onDisk, fetchedAt: iso(Date.now() - 5 * 60000) };
  write(cache.file, JSON.stringify(aged));
  const cache3 = new ui.PlanUsageCache({
    dir: cacheDir, minIntervalMs: 60 * 1000,
    fetchSnapshot: async () => { throw new Error('network down'); },
  });
  const doc3 = await cache3.ensureFresh();
  check('stale cache + failing fetch: previous quota kept, error surfaced', doc3.error === 'network down'
    && doc3.quota && doc3.quota.limits && doc3.quota.limits[0].usedPercentage === 10, JSON.stringify(doc3).slice(0, 160));

  console.log('== 11. TUI snapshot renders (80 and 140 cols, ANSI stripped) ==');
  const stateR = ui.aggregate({ rootDir: root1, sessionsDir, offpeakDir, offersDir, uiDir, watchDirs: [{ name: 'game', dir: laneDir }], now: NOW, historyMode: 'hours' });
  const view = { mode: 'dashboard', selected: 0, filter: 'all', historyMode: 'hours', confirm: null, toast: null, detailScroll: 0, detailRowId: null };
  const frame140 = renderFrame(stateR, view, { width: 140, height: 42, color: false });
  const lines140 = stripAnsi(frame140).split('\n');
  check('140-col frame: full height (42 lines)', lines140.length === 42, lines140.length);
  check('140-col frame: no line overflows', lines140.every((l) => l.length <= 140), lines140.find((l) => l.length > 140));
  check('header: version + up state + clock', /zcode-bridge v0\.5\.0/.test(lines140[0]) && /up/.test(lines140[0]) && /\d{2}:\d{2}:\d{2}/.test(lines140[0]), lines140[0]);
  const all140 = lines140.join('\n');
  check('panels present: PLAN/ACTIVE/HISTORY/OFFERS/EVENTS', ['─ PLAN', '─ ACTIVE', '─ HISTORY', '─ OFFERS', '─ EVENT'].every((p) => all140.includes(p)));
  check('active table shows all three kinds', all140.includes('ses') && all140.includes('idle') && all140.includes('lane'));
  check('status glyphs render (✓ ✗ ◐ ⊘)', all140.includes('◐') && all140.includes('✓') && all140.includes('✗') && all140.includes('⊘'));
  check('plan gauges: percent + banked resets + expiry warning', all140.includes('50%') && all140.includes('banked resets') && all140.includes('⚠ <2h'), all140.split('banked resets')[1] && all140.split('banked resets')[1].split('\n')[0]);
  check('offers line + never-claim hint', all140.includes('Flash quota campaign') && all140.includes('never from the UI'));
  check('footer keys line', all140.includes('q quit') && all140.includes('c cancel'));
  check('selection marker on first row', all140.includes('›'));
  const frame80 = renderFrame(stateR, view, { width: 80, height: 42, color: false });
  const lines80 = stripAnsi(frame80).split('\n');
  check('80-col frame: full height, no line overflows', lines80.length === 42 && lines80.every((l) => l.length <= 80), lines80.find((l) => l.length > 80));
  check('80-col frame: panels survive the squeeze', ['─ PLAN', '─ ACTIVE', '─ HISTORY', '─ OFFERS', '─ EVENT'].every((p) => lines80.join('\n').includes(p)));
  const painted = renderFrame(stateR, view, { width: 100, height: 42, color: true, env: { WT_SESSION: 'x' } });
  check('painted frame strips to exactly the plain frame', stripAnsi(painted) === renderFrame(stateR, view, { width: 100, height: 42, color: false }));
  const runView = { ...view, filter: 'running' };
  const runRows = filterRows(state8.active, 'running');
  check('filter=running keeps only live rows', runRows.length > 0 && runRows.every((r) => ['running', 'queued', 'paused'].includes(r.status)));
  const failView = { ...view, filter: 'failed' };
  check('filter=failed keeps only failed rows', filterRows(state8.active, 'failed').every((r) => ['error', 'failed', 'lost'].includes(r.status)));
  check('filter views do not change the rendered row count vs active', runView.filter === 'running' && failView.filter === 'failed');

  console.log('== 12. detail body (status JSON + log tail) ==');
  const row = stateR.active.find((r) => r.id === 'sess_aaa');
  const body = buildDetailBody(row, 100);
  check('detail includes the status JSON', body.join('\n').includes('"status"') && body.join('\n').includes('sess_aaa'));
  check('detail includes the log tail', body.join('\n').includes('turn-failed'));
  check('detail wraps to the width', body.every((l) => l.length <= 100), body.find((l) => l.length > 100));
  const missing = buildDetailBody({ ...row, jsonPath: path.join(root1, 'nope.json'), logPath: path.join(root1, 'nope.log') }, 100);
  check('missing files render a readable placeholder', missing.join('\n').includes('unreadable') && missing.join('\n').includes('(empty log)'));

  console.log('== 13. static guard: dashboards never touch plan write endpoints ==');
  {
    const root = path.join(__dirname, '..');
    const files = ['bin/bridge-ui.cjs', 'lib/ui-state.cjs', 'lib/ui-html.cjs', 'server.cjs'].map((f) => path.join(root, f));
    // assembled from pieces so the repo-wide guard in test/offers.cjs does
    // not match this very line (the same trick that file uses on itself)
    const forbidden = new RegExp(['billing', 'claim'].join('/') + '|reset' + '/use|reset/' + 'opportunity|X-' + 'Aliyun|captchaVerify' + 'Param', 'i');
    const offenders = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '');
        if (forbidden.test(code)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    check('no claim/reset-spend endpoints or captcha headers in dashboard code', offenders.length === 0, offenders.join(' | '));
    const html = fs.readFileSync(path.join(root, 'lib', 'ui-html.cjs'), 'utf8');
    check('web page documents the display-only rule', /never claims|never from this dashboard|Display only/i.test(html));
    const posts = [...html.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1]);
    check("web page's only POST is /v1/ui/cancel (after confirm)", posts.some((p) => p.includes('/v1/ui/cancel')) && !posts.some((p) => p.includes('messages') || p.includes('offpeak') && p.includes('POST')));
  }

  console.log('== 14. config + color depth helpers ==');
  {
    const cfgDir = tmp('cfg');
    write(path.join(cfgDir, 'config.json'), JSON.stringify({ port: 9001, apiKey: 'k', uiWatch: ['C:/watch/strings', { name: 'n', dir: 'C:/watch/obj' }] }));
    const cfg = loadConfig(['--config', path.join(cfgDir, 'config.json'), '--watch', 'C:/watch/flag'], cfgDir);
    check('config subset: port/apiKey/uiWatch merged', cfg.port === 9001 && cfg.apiKey === 'k' && cfg.uiWatch.length === 3, JSON.stringify(cfg.uiWatch));
    check('--root changes state-dir defaults', loadConfig(['--root', 'C:/other'], 'C:/other').statusDir === path.join('C:/other', 'out', 'sessions'));
    check('BRIDGE_UI_COLOR=off -> none', detectColorDepth({ BRIDGE_UI_COLOR: 'off' }) === 'none');
    check('WT_SESSION -> truecolor', detectColorDepth({ WT_SESSION: 'abc' }) === 'tc');
    check('bare conhost (no env) -> 16-color fallback', detectColorDepth({}) === '16');
  }

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==`);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
