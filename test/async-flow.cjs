#!/usr/bin/env node
'use strict';
/**
 * test/async-flow.cjs — async turns, on-disk session status, sessions_list
 * merging, timeout errors and cancel, exercised against a scripted fake of
 * the ZCode Protocol client (no harness needed, no quota spent).
 * Style follows test/mcp-smoke.cjs: PASS/FAIL lines, exit 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AgentManager } = require('../lib/agent-manager.cjs');
const { SessionStatusStore } = require('../lib/session-status.cjs');
const { ProtocolError } = require('../lib/zcode-protocol.cjs');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); PASS += 1; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); FAIL += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = [];

/** Scripted stand-in for ZCodeProtocolClient: one turn at a time, tests
 *  drive it via streamText()/finish()/fail()/cancelByServer(). */
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.running = true;
    this.seq = 0;
    this.stops = 0;
    this.stopUnsupported = false;
    this._resetTurn();
  }
  _resetTurn() {
    this.turnSession = null;
    this.turnStartedAt = 0;
    this.text = '';
    this.usage = null;
  }
  streamText(chunk) { this.text += chunk; }
  finish() {
    this.usage = this.usage || { input: 111, output: 22, cache: { read: 33 } };
    this._terminal('completed');
  }
  fail(errorMessage) { this._terminal('failed', errorMessage); }
  cancelByServer() { this._terminal('cancelled'); }
  _terminal(status, errorMessage) {
    this.emit('notification', {
      method: 'v4/telemetry/event',
      params: { sessionId: this.turnSession, kind: 'turn.terminal', status, errorMessage },
    });
  }
  _buildMessages() {
    if (!this.turnSession || !this.text) return [];
    const parts = [{ id: 'p1', messageID: 'm1', type: 'text', text: this.text }];
    if (this.usage) parts.push({ id: 'p2', messageID: 'm1', type: 'step-finish', tokens: this.usage, reason: 'stop' });
    return [{
      info: {
        id: 'm1', role: 'assistant', semantics: { kind: 'assistant_response' },
        time: { created: this.turnStartedAt },
      },
      parts,
    }];
  }
  async call(method, params) {
    switch (method) {
      case 'session/create':
        this.seq += 1;
        return {
          session: { sessionId: `fake-s-${this.seq}-${Math.random().toString(36).slice(2, 8)}` },
          settings: { model: { available: [{
            ref: { providerId: 'fake:provider', modelId: 'Fake-Model' },
            reasoning: { levels: [{ value: 'low' }, { value: 'high' }], defaultLevel: 'high' },
          }] } },
        };
      case 'session/setModel': return {};
      case 'session/subscribe': return {};
      case 'session/send':
        this._resetTurn();
        this.turnSession = params.sessionId;
        this.turnStartedAt = Date.now();
        return { accepted: true };
      case 'session/messages': return { messages: this._buildMessages() };
      case 'session/stop':
        this.stops += 1;
        if (this.stopUnsupported) throw new ProtocolError('method not found: session/stop', { code: -32601 });
        return {};
      case 'session/close': return {};
      default: return {};
    }
  }
}

/** Manager + fake client + throwaway statusDir/workspace/dummy harness files. */
function makeManager(cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-test-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'ZCode.exe'), '');
  fs.writeFileSync(path.join(dir, 'zcode.cjs'), '');
  const statusDir = path.join(dir, 'out', 'sessions');
  const mgr = new AgentManager({
    zcodeExe: path.join(dir, 'ZCode.exe'),
    zcodeBundle: path.join(dir, 'zcode.cjs'),
    workspacePath: path.join(dir, 'ws'),
    statusDir,
    model: { providerId: 'fake:provider', modelId: 'Fake-Model', options: { reasoningLevel: 'high' } },
    turnTimeoutMs: cfg.turnTimeoutMs || 60000,
    asyncTurnTimeoutMs: cfg.asyncTurnTimeoutMs,
  }, () => {});
  const fake = new FakeClient();
  // Bridge the fake's notifications into the manager's handler pump the way
  // AgentManager._startClient would for a real client.
  fake.on('notification', (msg) => {
    for (const h of mgr._notificationHandlers) {
      try { h(msg); } catch { /* pump must not break */ }
    }
  });
  mgr.ensureClient = async () => fake;
  mgr.client = fake;
  return { mgr, fake, statusDir };
}

(async () => {
  console.log('== 1. session persisted before the first turn ==');
  const m1 = makeManager();
  const created = await m1.mgr.createSession({});
  const sid = created.sessionId;
  const statusFile = path.join(m1.statusDir, `${sid}.json`);
  check('status file exists right after create', fs.existsSync(statusFile));
  const doc = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  check('schema: id/workspace/model/status/turns/pid', doc.id === sid && !!doc.workspace
    && doc.model && doc.model.modelId === 'Fake-Model' && doc.status === 'idle' && doc.turns === 0 && doc.pid === process.pid);
  check('schema: createdAt/lastActivity/turnId/usage/error', typeof doc.createdAt === 'number'
    && typeof doc.lastActivity === 'number' && doc.turnId === null && doc.usage === null && doc.error === null);

  console.log('== 2. async start -> wait -> done ==');
  const started = m1.mgr.startTurn(sid, 'do the thing');
  check('startTurn returns immediately: running + turnId', started.sessionId === sid
    && started.status === 'running' && typeof started.turnId === 'string');
  const early = await m1.mgr.waitTurn(sid, 150);
  check('wait before completion reports running', early.status === 'running', JSON.stringify(early));
  m1.fake.streamText('partial output so far…');
  await sleep(700); // let one 500ms poll pick the text up
  const snap = m1.mgr.sessionOutput(sid);
  check('sessionOutput sees streamed tail without blocking', /partial output/.test(snap.tail)
    && snap.status === 'running', JSON.stringify(snap));
  m1.fake.streamText('x'.repeat(3000) + 'FINAL_MARKER_DONE');
  m1.fake.finish();
  const done = await m1.mgr.waitTurn(sid, 10000);
  check('wait resolves done', done.status === 'done', JSON.stringify(done));
  check('finalText present', /FINAL_MARKER_DONE/.test(done.finalText || ''));
  check('usage mapped {input,output,cacheRead}', done.usage && done.usage.input === 111
    && done.usage.output === 22 && done.usage.cacheRead === 33, JSON.stringify(done.usage));
  check('model present', done.model && done.model.modelId === 'Fake-Model');
  const doc2 = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  check('disk: done + capped tails + finishedAt', doc2.status === 'done' && doc2.turns === 1
    && doc2.finalTextTail.length <= 2000 && /FINAL_MARKER_DONE/.test(doc2.finalTextTail)
    && typeof doc2.finishedAt === 'number');

  console.log('== 3. event log is NDJSON ==');
  const logLines = fs.readFileSync(path.join(m1.statusDir, `${sid}.log`), 'utf8').trim().split('\n');
  let parsed = [];
  try { parsed = logLines.map((l) => JSON.parse(l)); } catch { /* leave empty */ }
  const kinds = parsed.map((l) => l.event);
  check('log parses as NDJSON with lifecycle events', ['session-created', 'turn-started', 'turn-completed']
    .every((k) => kinds.includes(k)), kinds.join(','));
  check('log lines carry ts + sessionId', parsed.every((l) => l.ts && l.sessionId === sid));

  console.log('== 4. throttled + atomic streaming writes ==');
  const writesBefore = m1.mgr.status.writeCount;
  const logLinesBefore = logLines.length;
  for (let i = 0; i < 20; i++) m1.mgr._appendOutput(sid, 'y'.repeat(200));
  await sleep(50);
  check('rapid appends within 5s write no extra docs', m1.mgr.status.writeCount === writesBefore,
    `${m1.mgr.status.writeCount} vs ${writesBefore}`);
  check('rapid appends log no spam', fs.readFileSync(path.join(m1.statusDir, `${sid}.log`), 'utf8').trim().split('\n').length === logLinesBefore);
  let parses = true;
  try { JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { parses = false; }
  check('status file still parses', parses);
  check('no temp files left behind', fs.readdirSync(m1.statusDir).filter((f) => f.includes('.tmp-')).length === 0);

  console.log('== 5. blocking runTurn still works (backward compat) ==');
  const c5 = await m1.mgr.createSession({});
  setTimeout(() => { m1.fake.streamText('blocking ok'); m1.fake.finish(); }, 200);
  const rb = await m1.mgr.runTurn(c5.sessionId, 'blocking');
  check('blocking runTurn resolves text + usage', /blocking ok/.test(rb.text || '')
    && rb.usage && rb.usage.input === 111, JSON.stringify(rb).slice(0, 200));

  console.log('== 6. sessions_list merges memory + disk ==');
  const ghost = { id: 'ghost-session-1', workspace: 'C:/elsewhere', model: { providerId: 'p', modelId: 'M' },
    status: 'done', turns: 9, createdAt: 1, lastActivity: 2, pid: 4242 };
  fs.writeFileSync(path.join(m1.statusDir, 'ghost-session-1.json'), JSON.stringify(ghost));
  const list = m1.mgr.sessionsList();
  const live = list.find((s) => s.id === sid);
  const ghostEntry = list.find((s) => s.id === 'ghost-session-1');
  check('list includes live session (memory wins)', !!live && live.inMemory === true && live.status === 'done');
  check('list includes disk-only session', !!ghostEntry && ghostEntry.inMemory === false && ghostEntry.turns === 9);
  check('no duplicate ids', new Set(list.map((s) => s.id)).size === list.length);

  console.log('== 7. timeout error includes the sessionId ==');
  const m7 = makeManager({ turnTimeoutMs: 1500 });
  const c7 = await m7.mgr.createSession({});
  let timedOut = null;
  try { await m7.mgr.runTurn(c7.sessionId, 'slow turn'); } catch (e) { timedOut = e; }
  check('timeout throws', !!timedOut, timedOut && timedOut.message);
  check('timeout error message contains sessionId', !!timedOut && timedOut.message.includes(c7.sessionId), timedOut && timedOut.message);
  const d7 = JSON.parse(fs.readFileSync(path.join(m7.statusDir, `${c7.sessionId}.json`), 'utf8'));
  check('disk records the timeout as error', d7.status === 'error' && /did not finish/.test(d7.error || ''), JSON.stringify(d7).slice(0, 200));

  console.log('== 7b. async turn outlives the wait deadline: detached, then done ==');
  {
    // asyncTurnTimeoutMs (700ms) is deliberately shorter than turnTimeoutMs
    // (60s) to prove the async cap is the one governing detached turns.
    const m7b = makeManager({ turnTimeoutMs: 60000, asyncTurnTimeoutMs: 700 });
    const c7b = await m7b.mgr.createSession({});
    m7b.mgr.startTurn(c7b.sessionId, 'long async task');
    await sleep(1400); // past the 700 ms async wait deadline
    const w7b = await m7b.mgr.waitTurn(c7b.sessionId, 300);
    check('detached turn still reports running (never error)', w7b.status === 'running', JSON.stringify(w7b));
    check('wait view carries detached + waitDeadlineHitAt', w7b.detached === true && typeof w7b.waitDeadlineHitAt === 'number', JSON.stringify(w7b));
    const d7b = JSON.parse(fs.readFileSync(path.join(m7b.statusDir, `${c7b.sessionId}.json`), 'utf8'));
    check('disk keeps running + detached + waitDeadlineHitAt, no error', d7b.status === 'running'
      && d7b.detached === true && typeof d7b.waitDeadlineHitAt === 'number' && d7b.error === null, JSON.stringify(d7b).slice(0, 260));
    const log7b = fs.readFileSync(path.join(m7b.statusDir, `${c7b.sessionId}.log`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('log records the turn-detached event', log7b.some((l) => l.event === 'turn-detached'), log7b.map((l) => l.event).join(','));
    m7b.fake.streamText('finally finished the long task');
    m7b.fake.finish();
    const done7b = await m7b.mgr.waitTurn(c7b.sessionId, 10000);
    check('turn later flips to done with finalText', done7b.status === 'done' && /finally finished/.test(done7b.finalText || ''), JSON.stringify(done7b).slice(0, 260));
    const d7b2 = JSON.parse(fs.readFileSync(path.join(m7b.statusDir, `${c7b.sessionId}.json`), 'utf8'));
    check('disk reaches done with finalText after detach (detached kept)', d7b2.status === 'done'
      && /finally finished/.test(d7b2.finalTextTail || '') && d7b2.detached === true, JSON.stringify(d7b2).slice(0, 260));
  }

  console.log('== 7c. cancelled detached turn reaches cancelled, not error ==');
  {
    const m7c = makeManager({ asyncTurnTimeoutMs: 500 });
    const c7c = await m7c.mgr.createSession({});
    m7c.mgr.startTurn(c7c.sessionId, 'long task, cancelled after detach');
    await sleep(1000); // detach at ~500ms
    await m7c.mgr.cancelTurn(c7c.sessionId);
    const w7c = await m7c.mgr.waitTurn(c7c.sessionId, 10000);
    check('cancelled detached turn reports cancelled', w7c.status === 'cancelled', JSON.stringify(w7c));
    const d7c = JSON.parse(fs.readFileSync(path.join(m7c.statusDir, `${c7c.sessionId}.json`), 'utf8'));
    check('disk records cancelled after detach', d7c.status === 'cancelled' && d7c.detached === true, JSON.stringify(d7c).slice(0, 240));
  }

  console.log('== 8. cancel: interrupt confirmed by the harness ==');
  const m8 = makeManager();
  const c8 = await m8.mgr.createSession({});
  m8.mgr.startTurn(c8.sessionId, 'long task');
  m8.fake.streamText('working…');
  setTimeout(() => m8.fake.cancelByServer(), 250);
  const r8 = await m8.mgr.cancelTurn(c8.sessionId);
  check('cancel reports interrupted via session/stop', r8.interrupted === true && r8.status === 'cancelled', JSON.stringify(r8));
  check('session/stop was sent to the app-server', m8.fake.stops >= 1);
  const w8 = await m8.mgr.waitTurn(c8.sessionId, 8000);
  check('wait after cancel reports cancelled', w8.status === 'cancelled', JSON.stringify(w8));
  const d8 = JSON.parse(fs.readFileSync(path.join(m8.statusDir, `${c8.sessionId}.json`), 'utf8'));
  check('disk status cancelled', d8.status === 'cancelled');

  console.log('== 9. cancel grace when the harness never confirms ==');
  const m9 = makeManager();
  const c9 = await m9.mgr.createSession({});
  m9.mgr.startTurn(c9.sessionId, 'stuck task');
  await sleep(150);
  await m9.mgr.cancelTurn(c9.sessionId);
  const w9 = await m9.mgr.waitTurn(c9.sessionId, 10000);
  check('cancel grace resolves cancelled without terminal telemetry', w9.status === 'cancelled', JSON.stringify(w9));

  console.log('== 10. failed turn classifies as error ==');
  const m10 = makeManager();
  const c10 = await m10.mgr.createSession({});
  m10.mgr.startTurn(c10.sessionId, 'boom');
  setTimeout(() => m10.fake.fail('provider exploded'), 200);
  const w10 = await m10.mgr.waitTurn(c10.sessionId, 8000);
  check('failed turn surfaces error status + message', w10.status === 'error'
    && /provider exploded/.test(w10.error || ''), JSON.stringify(w10).slice(0, 200));

  console.log('== 11. store unit: throttle, force, event log ==');
  const store = new SessionStatusStore(path.join(os.tmpdir(), `zbridge-store-${Date.now()}`));
  store.record('s-x', { id: 's-x', status: 'idle' }, { force: true });
  store.record('s-x', { id: 's-x', status: 'running' }); // throttled, no event
  check('throttled write keeps previous doc', JSON.parse(fs.readFileSync(store.fileFor('s-x'), 'utf8')).status === 'idle'
    && store.writeCount === 1);
  store.record('s-x', { id: 's-x', status: 'done' }, { force: true, event: { event: 'turn-completed' } });
  const logX = fs.readFileSync(store.logFileFor('s-x'), 'utf8').trim().split('\n');
  check('forced write updates doc + logs exactly one event line', JSON.parse(fs.readFileSync(store.fileFor('s-x'), 'utf8')).status === 'done'
    && store.writeCount === 2 && logX.length === 1 && JSON.parse(logX[0]).event === 'turn-completed');

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==`);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
