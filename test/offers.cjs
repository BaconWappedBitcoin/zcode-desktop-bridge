#!/usr/bin/env node
'use strict';
/**
 * test/offers.cjs — offer detection exercised against scripted fakes (no
 * network, no harness). Also a static guard: no code path may reference the
 * claim endpoint or captcha headers. Style follows test/offpeak.cjs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OffersManager, OffersClient, normalizeOffers, classifyKind, extractTokens,
  campaignClaimPlanIds, campaignPlanArgs,
} = require('../lib/offers.cjs');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); PASS += 1; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); FAIL += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];

// ------------------------------------------------------------------ fakes
function fakeClient({ plans = [], deliveries = [] } = {}) {
  return {
    deviceMid: 'mid-test',
    plans,
    deliveries,
    async preview() { return { serverTimeMs: 1791054156000, plans: JSON.parse(JSON.stringify(this.plans)) }; },
    async touch() { return { serverTimeMs: 1791054156000, deliveries: JSON.parse(JSON.stringify(this.deliveries)) }; },
  };
}

function planFixture(id, { period = 'DAILY', grants = [50000], effectiveAt = null, name } = {}) {
  return {
    plan_id: id,
    name: name || `Offer ${id}`,
    description: 'limited-time trial',
    priority: 10,
    entitlements: grants.map((g, i) => ({
      entitlement_id: `${id}-ent-${i}`,
      show_name: `${id} bonus`,
      meter: 'model_usage',
      unit_type: 'tokens',
      capabilities: [],
      grant_units: g,
      period,
      priority: 1,
      ...(effectiveAt !== null ? { effective_at: effectiveAt } : {}),
    })),
  };
}

function campaignFixture(planId, endsAtSec, name) {
  const zp = {
    name: name || `Campaign ${planId}`,
    ends_at: endsAtSec,
    entitlements: [{ meter: 'model_usage', grant_units: 50000, unit_type: 'tokens', show_name: `${planId} bonus`, period: 'DAILY' }],
  };
  return {
    campaign_id: 'camp-1',
    priority: 50,
    resource_position: 'banner',
    banner: {
      layout: 'v1',
      background: { type: 'bundle', bundle: { bundle: { src: 'https://x/b.zip', sha256: 'a'.repeat(64) }, entry: 'index.html' }, args: { zcode_plan: zp } },
      buttons: [
        { text: { format: 'plaintext', content: '领取' }, action: { type: 'claim_zcode_plan', args: { plan_id: planId } } },
        { text: { format: 'plaintext', content: 'close' }, action: { type: 'close' } },
      ],
    },
  };
}

function makeManager(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-offers-'));
  tmpDirs.push(dir);
  const toasts = [];
  const m = new OffersManager({
    dir,
    client: opts.client || fakeClient(opts),
    logger: () => {},
    pollMs: opts.pollMs !== undefined ? opts.pollMs : 600000,
    toasts: opts.toasts !== undefined ? opts.toasts : true,
    toastImpl: async (t) => { toasts.push(t); return true; },
    loadResetStatus: opts.loadResetStatus !== undefined ? opts.loadResetStatus : async () => null,
    ...(opts.mgrOpts || {}),
  });
  return { m, dir, toasts };
}

(async () => {
  console.log('== 1. normalization: preview plans -> offers ==');
  const now = 1791054156000;
  const offers1 = normalizeOffers({
    previewPlans: [planFixture('p-daily'), planFixture('p-once', { period: 'ONE_TIME', grants: [120000, 30000] })],
    deliveries: [],
    resetStatus: null,
    now,
  });
  const daily = offers1.find((o) => o.id === 'p-daily');
  const once = offers1.find((o) => o.id === 'p-once');
  check('daily offer: kind daily + tokens + claimable', daily && daily.kind === 'daily'
    && daily.tokens.amount === 50000 && daily.tokens.unit === 'tokens' && daily.claimable === true && daily.claimed === false, JSON.stringify(daily));
  check('oneTime offer: kind oneTime + max grant_units', once && once.kind === 'oneTime' && once.tokens.amount === 120000, JSON.stringify(once));
  check('no endsAt without a campaign', daily.endsAt === null && once.startsAt === null);
  const eff = normalizeOffers({ previewPlans: [planFixture('p-fut', { effectiveAt: 1893456000 })], now })[0];
  check('entitlement effective_at -> startsAt (s -> ISO)', eff.startsAt === new Date(1893456000 * 1000).toISOString(), eff.startsAt);
  check('classifyKind maps period strings', classifyKind('DAILY') === 'daily' && classifyKind('ONE_TIME') === 'oneTime'
    && classifyKind('one-time') === 'oneTime' && classifyKind('') === 'daily');
  check('extractTokens ignores non model_usage meters', extractTokens([{ meter: 'seats', grant_units: 99 }, { meter: 'model_usage', grant_units: 5 }]).amount === 5);

  console.log('== 2. normalization: campaign merge + reset opportunities ==');
  const offers2 = normalizeOffers({
    previewPlans: [planFixture('p-daily')],
    deliveries: [campaignFixture('p-daily', 1791060000), campaignFixture('p-camp-only', 1791070000, 'Flash drop')],
    resetStatus: { available: { five_hour: [{ expireAt: '2026-10-05T00:00:00.000Z' }, { expireAt: '2026-10-05T00:00:00.000Z' }], week: [] } },
    now,
  });
  const merged = offers2.find((o) => o.id === 'p-daily');
  check('campaign adds endsAt (s -> ISO) + keeps tokens', merged.endsAt === new Date(1791060000 * 1000).toISOString()
    && merged.tokens.amount === 50000 && merged.campaignId === 'camp-1', JSON.stringify(merged));
  const campOnly = offers2.find((o) => o.id === 'p-camp-only');
  check('campaign-only offer listed with title from campaign', campOnly && campOnly.title === 'Flash drop' && campOnly.claimable === true);
  const reset = offers2.find((o) => o.kind === 'reset-opportunity');
  check('banked resets -> reset-opportunity entry (count, earliest endsAt, not claimable)',
    reset && reset.count === 2 && reset.endsAt === '2026-10-05T00:00:00.000Z' && reset.claimable === false
    && /5-hour window resets available/.test(reset.title), JSON.stringify(reset));
  check('campaign helpers find claim plan ids + zcode_plan args',
    campaignClaimPlanIds(campaignFixture('x', 1)).length === 1
    && campaignPlanArgs(campaignFixture('x', 1)).name === 'Campaign x');

  console.log('== 3. dedup: one event + one toast per offer id ==');
  {
    const o3 = makeManager({ client: fakeClient({ plans: [planFixture('p-1')] }) });
    await o3.m.check();
    await o3.m.check();
    await o3.m.check();
    const events = fs.readFileSync(o3.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('exactly one offer-new event for repeated checks', events.filter((e) => e.event === 'offer-new').length === 1
      && events.find((e) => e.event === 'offer-new').id === 'p-1', JSON.stringify(events.map((e) => e.event)));
    check('exactly one toast for the offer', o3.toasts.length === 1 && o3.toasts[0].title === 'ZCode offer available'
      && /Offer p-1/.test(o3.toasts[0].body) && o3.toasts[0].launch === 'zcode://', JSON.stringify(o3.toasts));
    const state = JSON.parse(fs.readFileSync(o3.m.stateFile, 'utf8'));
    check('state.json holds offers + dedup maps', state.offers.length === 1 && state.toasted['p-1'] === true
      && typeof state.lastCheckAt === 'string');
  }

  console.log('== 4. expiry reminder: <30min once, >30min silent ==');
  {
    const soonSec = Math.floor(Date.now() / 1000) + 10 * 60;
    const laterSec = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    const o4 = makeManager({ client: fakeClient({ plans: [planFixture('p-soon')], deliveries: [campaignFixture('p-soon', soonSec)] }) });
    await o4.m.check();
    await o4.m.check();
    let events = fs.readFileSync(o4.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('offer-expiring emitted once for <30min offer', events.filter((e) => e.event === 'offer-expiring').length === 1
      && events.find((e) => e.event === 'offer-expiring').id === 'p-soon');
    check('new-offer toast + expiry toast (2 total, per-offer dedup)', o4.toasts.length === 2 && /ends /.test(o4.toasts[1].body));

    const o4b = makeManager({ client: fakeClient({ plans: [planFixture('p-later')], deliveries: [campaignFixture('p-later', laterSec)] }) });
    await o4b.m.check();
    events = fs.readFileSync(o4b.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('no expiry event when >30min left', events.every((e) => e.event !== 'offer-expiring') && o4b.toasts.length === 1);
  }

  console.log('== 5. offer-gone event when an offer leaves the list ==');
  {
    const client = fakeClient({ plans: [planFixture('p-temp')] });
    const o5 = makeManager({ client });
    await o5.m.check();
    client.plans = [];
    await o5.m.check();
    const events = fs.readFileSync(o5.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('offer-gone recorded with lastSeenAt', events.some((e) => e.event === 'offer-gone' && e.id === 'p-temp' && e.lastSeenAt));
  }

  console.log('== 6. reset-opportunity dedup + passive-only ==');
  {
    const rs = { available: { five_hour: [{ expireAt: '2026-10-05T00:00:00.000Z' }], week: [] } };
    const o6 = makeManager({ loadResetStatus: async () => rs });
    await o6.m.check();
    await o6.m.check();
    const events = fs.readFileSync(o6.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('banked reset notified once per id', events.filter((e) => e.event === 'offer-new' && e.kind === 'reset-opportunity').length === 1
      && o6.toasts.length === 1);
    const view = o6.m._view();
    check('view carries the never-claim note + claimableCount', view.claimableCount === 0 && /never claims/.test(view.note));
  }

  console.log('== 7. disabled poller (offersPollMs=0) ==');
  {
    const o7 = makeManager({ pollMs: 0 });
    o7.m.start();
    await sleep(100);
    check('no timer, no pid file, no events when disabled', o7.m._timer === null && !fs.existsSync(o7.m.pidFile)
      && !fs.existsSync(o7.m.eventsFile));
    o7.m.stop();
  }

  console.log('== 8. pid lock: first-alive wins, stale pid taken over ==');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-offers-'));
    tmpDirs.push(dir);
    const mk = (extra) => new OffersManager(Object.assign({
      dir, client: fakeClient({ plans: [planFixture('p-x')] }), logger: () => {}, pollMs: 600000,
      toastImpl: async () => true, loadResetStatus: async () => null,
    }, extra));
    const a = mk(); a.start();
    check('first process owns the lock', a.dormant === false && a._timer !== null);
    a.stop(); // release before its first check fires; keeps the rest deterministic
    // a real OTHER live process must hold the lock for dormancy (a.pid === our
    // pid would be "ours", so park the lock on a spawned child instead)
    const holder = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    await sleep(150);
    fs.writeFileSync(path.join(dir, 'poller.pid'), `${holder.pid}\n`);
    const b = mk(); b.start();
    check('second process stays dormant (no double-toasting)', b.dormant === true && b._timer === null);
    const viewB = await b.list({ refresh: true });
    check('dormant refresh is read-only: view returned, nothing written, no toast',
      viewB.offers.length === 1 && !fs.existsSync(path.join(dir, 'events.log'))
      && !fs.existsSync(path.join(dir, 'state.json')) && !fs.readFileSync(path.join(dir, 'poller.pid'), 'utf8').includes(String(process.pid)),
      JSON.stringify(viewB.offers.map((o) => o.id)));
    check('stop() leaves a foreign lock alone', fs.readFileSync(path.join(dir, 'poller.pid'), 'utf8').trim() === String(holder.pid));
    holder.kill();
    await sleep(150);
    const c = mk(); c.start();
    check('dead foreign pid taken over after release', c.dormant === false && c._timer !== null);
    // stale pid: write a dead pid, a fresh manager must take over
    c.stop();
    fs.writeFileSync(path.join(dir, 'poller.pid'), '999999999\n');
    const d = mk(); d.start();
    check('stale (dead) pid taken over', d.dormant === false && d._timer !== null);
    d.stop();
  }

  console.log('== 9. client: URL/headers mirror the desktop (X-Device-Mid required) ==');
  {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (/billing\/preview/.test(String(url))) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { server_time: 1791054156, plans: [] } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { server_time: 1791054156, deliveries: [] } }) };
    };
    const client = new OffersClient({
      fetchImpl: fakeFetch,
      deviceMid: 'mid-1234',
      loadAuth: () => ({ resetHeaders: { Authorization: 'Bearer jwt-x' } }),
    });
    const p = await client.preview();
    const t = await client.touch();
    check('preview URL carries app_version + platform', /\/api\/v1\/zcode-plan\/billing\/preview\?app_version=[\d.]+&platform=win/.test(calls[0].url), calls[0].url);
    check('preview headers: Bearer + X-Device-Mid + version/platform', calls[0].init.headers.Authorization === 'Bearer jwt-x'
      && calls[0].init.headers['X-Device-Mid'] === 'mid-1234' && !!calls[0].init.headers['X-ZCode-App-Version']);
    check('touch URL carries seq + locale + language header', /\/api\/v1\/marketing\/touch\?seq=0&locale=zh-CN/.test(calls[1].url)
      && calls[1].init.headers['X-Client-Language'] === 'zh-CN', calls[1].url);
    check('shapes parsed', p.plans.length === 0 && t.deliveries.length === 0 && p.serverTimeMs === 1791054156000);

    const bad = new OffersClient({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 3001, msg: 'parameter error' }) }),
      loadAuth: () => ({ resetHeaders: { Authorization: 'Bearer jwt-x' } }),
    });
    let e9 = null;
    try { await bad.preview(); } catch (e) { e9 = e; }
    check('business code 3001 (missing device-mid server answer) surfaces as error', !!e9 && /3001/.test(e9.message));
  }

  console.log('== 10. state survives restart (no re-toast) ==');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-offers-'));
    tmpDirs.push(dir);
    const mk = () => {
      const toasts = [];
      const m = new OffersManager({
        dir, client: fakeClient({ plans: [planFixture('p-persist')] }), logger: () => {}, pollMs: 600000,
        toastImpl: async (t) => { toasts.push(t); return true; }, loadResetStatus: async () => null,
      });
      return { m, toasts };
    };
    const first = mk();
    await first.m.check();
    const second = mk(); // fresh manager, same dir -> reloads state.json
    await second.m.check();
    check('restarted manager does not re-toast known offers', first.toasts.length === 1 && second.toasts.length === 0
      && second.m._view().offers.length === 1);
  }

  console.log('== 11. STATIC GUARD: no code path references the claim endpoint ==');
  {
    const root = path.join(__dirname, '..');
    const files = [];
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git' || name === 'out' || name === 'bridge-workspace') continue;
        const full = path.join(d, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else if (/\.cjs$|\.js$|\.mjs$/.test(name)) files.push(full);
      }
    };
    walk(root);
    // pattern assembled at runtime so this guard's own source does not match
    const forbidden = new RegExp(['billing', 'claim'].join('/') + '|X-Aliyun' + '-Captcha|captchaVerify' + 'Param', 'i');
    const offenders = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '');
        if (forbidden.test(code)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    check('claim endpoint / captcha appear only in comments, never in code', offenders.length === 0, offenders.join(' | '));
    check('offers.cjs documents the never-claim rule', /NEVER CLAIMS/.test(fs.readFileSync(path.join(root, 'lib', 'offers.cjs'), 'utf8')));
  }

  console.log('== 12. check error path ==');
  {
    const client = fakeClient({});
    client.preview = async () => { throw new Error('billing/preview: HTTP 500'); };
    const o12 = makeManager({ client });
    let threw = false;
    try { await o12.m.check(); } catch { threw = true; }
    const events = fs.readFileSync(o12.m.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('failed check throws, records check-error + lastError', threw
      && events.some((e) => e.event === 'check-error' && /HTTP 500/.test(e.error))
      && /HTTP 500/.test(o12.m.state.lastError));
  }

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==`);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
