#!/usr/bin/env node
'use strict';
/**
 * test/offpeak.cjs — idle-time (off-peak) task lifecycle exercised against a
 * scripted fake of the cloud ticket API and a stub AgentManager (no harness,
 * no quota, no network). Style follows test/async-flow.cjs: PASS/FAIL lines,
 * exit 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OffPeakManager, OffPeakCloudClient, OffPeakApiError, CONTINUATION_PROMPT } = require('../lib/offpeak.cjs');
const { ZCodeProtocolClient } = require('../lib/zcode-protocol.cjs');

let PASS = 0;
let FAIL = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); PASS += 1; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); FAIL += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, every = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(every);
  }
  return fn();
}
const tmpDirs = [];

/** Scripted stand-in for OffPeakCloudClient. */
class FakeCloud {
  constructor() {
    this.availability = { canTakeNumber: true, nextTakeAt: null };
    this.availError = null;
    this.nextTake = { ticketId: 'tick-1', state: 'queued', position: 3, nextPollAfterMs: 60000 };
    this.takeCalls = [];
    this.statusMap = new Map(); // ticketId -> {state, position}
    this.settled = [];
    this.auth = { jwt: 'jwt-x', codingPlanApiKey: 'key-x' };
  }
  async getAvailability() {
    if (this.availError) throw this.availError;
    return this.availability;
  }
  async takeTicket(taskId) {
    this.takeCalls.push(taskId);
    const t = Object.assign({}, this.nextTake);
    this.statusMap.set(t.ticketId, { state: t.state, position: t.position });
    return t;
  }
  async batchStatus(ticketIds) {
    return {
      nextPollAfterMs: null,
      tickets: ticketIds.map((id) => {
        const st = this.statusMap.get(id) || { state: 'queued', position: null };
        return { ticketId: id, state: st.state, position: st.position, activeDeadline: null };
      }),
    };
  }
  async settle(ticketId) { this.settled.push(ticketId); return { settled: true }; }
  async loadAuth() { return this.auth; }
}

/** Minimal AgentManager stub: enough surface for OffPeakManager. */
function fakeManager(dir) {
  const sessions = new Map([['live-1', { sessionId: 'live-1' }]]);
  return {
    workspacePath: path.join(dir, 'ws'),
    sessionInfo: (id) => sessions.get(id) || null,
    stopSession: async () => {},
    status: { fileFor: (sid) => path.join(dir, 'sessions', `${sid}.json`) },
    ensureClient: async () => { throw new Error('not needed in unit tests'); },
    _activateAccount: async () => ({ models: [] }),
    runTurn: async () => { throw new Error('override me'); },
  };
}

function makeOff(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-offpeak-'));
  tmpDirs.push(dir);
  const cloud = opts.cloud || new FakeCloud();
  const manager = opts.manager || fakeManager(dir);
  const m = new OffPeakManager({
    manager, cloud, dir,
    logger: () => {},
    pollIntervalMs: 60000,
    ...(opts.mgrOpts || {}),
  });
  return { m, cloud, dir, manager };
}

(async () => {
  console.log('== 1. create -> queued task + atomic on-disk file ==');
  const o1 = makeOff();
  o1.m._runTask = async () => { throw new Error('should not run while queued'); };
  const t1 = await o1.m.create({ title: 'Refactor utils', prompt: 'Do the refactor. Deliver a summary.' });
  check('view: id prefix + status queued + queuePosition', /^offpeak-/.test(t1.offPeakTaskId)
    && t1.status === 'queued' && t1.queuePosition === 3, JSON.stringify(t1));
  check('view: createdAt + model selection + permissionMode default', typeof t1.createdAt === 'number'
    && t1.model.modelId === 'GLM-5.3-Flash' && t1.permissionMode === 'yolo');
  const file1 = o1.m.store.fileFor(t1.offPeakTaskId);
  check('status file written', fs.existsSync(file1));
  const doc1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
  check('doc: ticket bound + prompt retained', doc1.serverTicketId === 'tick-1' && /refactor/i.test(doc1.prompt));
  const log1 = fs.readFileSync(o1.m.store.logFileFor(t1.offPeakTaskId), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('event log: created line with ticket info', log1.some((l) => l.event === 'created' && l.ticketId === 'tick-1'));
  o1.m.stop();

  console.log('== 2. create validation ==');
  const o2 = makeOff();
  let e2 = null;
  try { await o2.m.create({ title: '', prompt: 'x' }); } catch (e) { e2 = e; }
  check('empty title rejected', !!e2 && /title/.test(e2.message));
  e2 = null;
  try { await o2.m.create({ title: 't', prompt: 'p', model: 'Nope-1' }); } catch (e) { e2 = e; }
  check('unknown model rejected with allowed list', !!e2 && /not an idle-time allowed model/.test(e2.message)
    && /GLM-5.3/.test(e2.message), e2 && e2.message);
  e2 = null;
  try { await o2.m.create({ title: 't', prompt: 'p', permissionMode: 'danger' }); } catch (e) { e2 = e; }
  check('bad permissionMode rejected', !!e2 && /permissionMode/.test(e2.message));
  e2 = null;
  try { await o2.m.create({ title: 't', prompt: 'p', sessionId: 'ghost' }); } catch (e) { e2 = e; }
  check('binding an unknown session rejected', !!e2 && /unknown session ghost/.test(e2.message));
  o2.m.stop();

  console.log('== 3. quota / eligibility errors carry next-allowed time ==');
  const o3 = makeOff();
  o3.cloud.availability = { canTakeNumber: false, nextTakeAt: Date.now() + 12 * 60 * 1000 };
  let e3 = null;
  try { await o3.m.create({ title: 't', prompt: 'p' }); } catch (e) { e3 = e; }
  check('quota error thrown', e3 instanceof OffPeakApiError && e3.kind === 'quota');
  check('describe() names the wait', /another task in 12m/.test(e3.describe()), e3 && e3.describe());
  o3.cloud.availError = new OffPeakApiError('off-peak /ticket/availability failed: HTTP 403 code=3101', { httpStatus: 403, bizCode: 3101 });
  let e3b = null;
  try { await o3.m.create({ title: 't', prompt: 'p' }); } catch (e) { e3b = e; }
  check('eligibility error classified', e3b instanceof OffPeakApiError && e3b.kind === 'eligibility'
    && /Coding Plan subscription/.test(e3b.describe()), e3b && e3b.describe());
  check('no task written on failure', o3.m._docs().length === 0 && o3.cloud.takeCalls.length === 0);
  o3.m.stop();

  console.log('== 4. bound session: one pending task per session ==');
  const o4 = makeOff();
  const b1 = await o4.m.create({ title: 'a', prompt: 'p', sessionId: 'live-1' });
  check('boundSessionId recorded', o4.m._byId(b1.offPeakTaskId).boundSessionId === 'live-1');
  let e4 = null;
  try { await o4.m.create({ title: 'b', prompt: 'p', sessionId: 'live-1' }); } catch (e) { e4 = e; }
  check('second bound task rejected', !!e4 && /already has a pending idle-time task/.test(e4.message));
  await o4.m.cancel(b1.offPeakTaskId);
  const b2 = await o4.m.create({ title: 'c', prompt: 'p', sessionId: 'live-1' });
  check('binding allowed again after terminal', !!b2.offPeakTaskId);
  o4.m.stop();

  console.log('== 5. list refresh pulls live queue positions to disk ==');
  const o5 = makeOff();
  const t5 = await o5.m.create({ title: 't', prompt: 'p' });
  o5.cloud.statusMap.set('tick-1', { state: 'queued', position: 1 });
  const l5 = await o5.m.list();
  const v5 = l5.tasks.find((x) => x.offPeakTaskId === t5.offPeakTaskId);
  check('list view shows refreshed position', v5.queuePosition === 1, JSON.stringify(v5));
  const doc5 = JSON.parse(fs.readFileSync(o5.m.store.fileFor(t5.offPeakTaskId), 'utf8'));
  check('disk mirror refreshed', doc5.queuePosition === 1);
  check('view links session status file only when sessionId known', v5.sessionStatusFile === undefined);
  o5.m.stop();

  console.log('== 6. ticket ready -> dispatch -> completed + settle ==');
  const o6 = makeOff();
  const sends = [];
  o6.m._runTask = async (task) => { sends.push(task.id); };
  o6.cloud.nextTake = { ticketId: 'tick-6', state: 'ready', position: 1, nextPollAfterMs: 60000 };
  const t6 = await o6.m.create({ title: 'go', prompt: 'do it' });
  check('create with ready ticket kicks dispatch immediately', await waitFor(() => o6.m._byId(t6.offPeakTaskId).status === 'completed'));
  const doc6 = o6.m._byId(t6.offPeakTaskId);
  check('run executed once + attempts counted', sends.length === 1 && doc6.attempts === 1);
  check('settled after completion', o6.cloud.settled.includes('tick-6'));
  const log6 = fs.readFileSync(o6.m.store.logFileFor(t6.offPeakTaskId), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('event log: dispatch-started -> turn-completed -> settled',
    ['dispatch-started', 'turn-completed', 'settled'].every((k) => log6.some((l) => l.event === k)), log6.map((l) => l.event).join(','));
  o6.m.stop();

  console.log('== 6b. real _runTask sends the desktop-identical modelExecution params ==');
  {
    let seen = null;
    const dir6b = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-offpeak-'));
    tmpDirs.push(dir6b);
    const mgr6b = fakeManager(dir6b);
    mgr6b.ensureClient = async () => ({});
    mgr6b._activateAccount = async () => ({ models: [] });
    mgr6b.createSession = async () => ({ sessionId: 'run-6b' });
    mgr6b.runTurn = async (sid, prompt, opts) => { seen = { sid, prompt, opts }; return { finalText: 'ok' }; };
    const o6b = makeOff({ manager: mgr6b });
    o6b.cloud.auth = o6b.cloud.auth || { jwt: 'jwt-test', planKey: 'pk-test' };
    const t6b = await o6b.m.create({ title: 'params', prompt: 'p' });
    const task6b = o6b.m._byId(t6b.offPeakTaskId);
    task6b.serverTicketId = task6b.serverTicketId || 'tick-6b';
    await o6b.m._runTask(task6b);
    const me = seen && seen.opts && seen.opts.extraSendParams && seen.opts.extraSendParams.modelExecution;
    check('modelExecution.selectionScope === "execution" (harness schema requires it)', !!me && me.selectionScope === 'execution', JSON.stringify(me));
    check('modelExecution.memoryExtraction === "skip" + requestAuth present', !!me && me.memoryExtraction === 'skip' && !!me.requestAuth);
    check('off-peak run type + task id sent', seen.opts.extraSendParams.offPeakRunType === 'init' && seen.opts.extraSendParams.offPeakTaskId === task6b.id);
    o6b.m.stop();
  }

  console.log('== 7. failed run -> failed status + error retained ==');
  const o7 = makeOff();
  o7.m._runTask = async () => { throw new Error('provider exploded'); };
  o7.cloud.nextTake = { ticketId: 'tick-7', state: 'ready', position: 1, nextPollAfterMs: 60000 };
  const t7 = await o7.m.create({ title: 'boom', prompt: 'p' });
  check('status failed', await waitFor(() => o7.m._byId(t7.offPeakTaskId).status === 'failed'));
  check('lastError recorded + ticket settled', /provider exploded/.test(o7.m._byId(t7.offPeakTaskId).lastError)
    && o7.cloud.settled.includes('tick-7'));
  o7.m.stop();

  console.log('== 8. ticket expired mid-run -> requeue + resume continuation ==');
  const o8 = makeOff();
  o8.m._runTask = async () => { throw new OffPeakApiError('off-peak ticket expired: t', { bizCode: 3102 }); };
  o8.cloud.nextTake = { ticketId: 'tick-8', state: 'ready', position: 1, nextPollAfterMs: 60000 };
  const t8 = await o8.m.create({ title: 'x', prompt: 'p' });
  await waitFor(() => o8.m._byId(t8.offPeakTaskId).status !== 'running');
  await sleep(100);
  const doc8 = o8.m._byId(t8.offPeakTaskId);
  check('requeued (not failed) after ticket expiry', doc8.status === 'queued' && doc8.needsResume === true, JSON.stringify(doc8.status));
  check('ticket retaken', o8.cloud.takeCalls.includes(t8.offPeakTaskId) && o8.cloud.takeCalls.length >= 2 && doc8.serverTicketId === 'tick-8');
  o8.m.stop();

  console.log('== 9. pause / continue (with expired ticket retake) ==');
  const o9 = makeOff();
  const t9 = await o9.m.create({ title: 'hold', prompt: 'p' });
  const paused = await o9.m.pause(t9.offPeakTaskId);
  check('paused', paused.status === 'paused');
  o9.m._runTask = async () => { throw new Error('paused tasks must not dispatch'); };
  o9.cloud.statusMap.set('tick-1', { state: 'ready', position: 1 });
  await o9.m._syncPass();
  await sleep(150);
  check('poller skips paused tasks', o9.m._byId(t9.offPeakTaskId).status === 'paused');
  o9.cloud.statusMap.set('tick-1', { state: 'expired', position: null });
  o9.cloud.nextTake = { ticketId: 'tick-9b', state: 'queued', position: 5, nextPollAfterMs: 60000 };
  const cont = await o9.m.continue(t9.offPeakTaskId);
  check('continue re-queues + retakes expired ticket', cont.status === 'queued'
    && o9.m._byId(t9.offPeakTaskId).serverTicketId === 'tick-9b' && cont.queuePosition === 5, JSON.stringify(cont));
  let e9 = null;
  try { await o9.m.continue(t9.offPeakTaskId); } catch (e) { e9 = e; }
  check('continue on non-paused rejected', !!e9 && /not paused/.test(e9.message));
  o9.m.stop();

  console.log('== 10. cancel + delete ==');
  const o10 = makeOff();
  const t10 = await o10.m.create({ title: 'bye', prompt: 'p' });
  const c10 = await o10.m.cancel(t10.offPeakTaskId);
  check('cancel marks cancelled + settles ticket', c10.status === 'cancelled' && waitFor(() => o10.cloud.settled.includes('tick-1')));
  const again = await o10.m.cancel(t10.offPeakTaskId);
  check('cancel is idempotent on terminal tasks', again.status === 'cancelled');
  const d10 = await o10.m.delete(t10.offPeakTaskId);
  check('delete removes the files', d10.deleted === true && !fs.existsSync(o10.m.store.fileFor(t10.offPeakTaskId)));
  o10.m.stop();

  console.log('== 11. host-request handler (agent OffPeakCreate tool path) ==');
  const o11 = makeOff();
  const r11 = await o11.m.handleHostRequest('offPeak/create', {
    title: 'from agent', prompt: 'work', permissionMode: 'plan', model: 'GLM-5.3', boundSessionId: 'live-1',
  });
  check('create result mirrors desktop shape {ok, task}', r11.ok === true && r11.task.offPeakTaskId
    && r11.task.status === 'queued' && r11.task.permissionMode === 'plan', JSON.stringify(r11).slice(0, 200));
  check('requested model honored', r11.task.model.modelId === 'GLM-5.3');
  o11.cloud.availability = { canTakeNumber: false, nextTakeAt: Date.now() + 60000 };
  const r11b = await o11.m.handleHostRequest('offPeak/create', { title: 'x', prompt: 'y' });
  check('failure mirrors desktop {ok:false, failureStage, errorCategory, errorCode}',
    r11b.ok === false && r11b.failureStage === 'ticket_request' && r11b.errorCategory === 'quota_3103' && r11b.errorCode === '3103'
    && /another task/.test(r11b.message), JSON.stringify(r11b));
  const r11c = await o11.m.handleHostRequest('offPeak/list', {});
  check('list returns {tasks} array', Array.isArray(r11c.tasks) && r11c.tasks.length >= 1);
  o11.m.stop();

  console.log('== 12. protocol: server->client offPeak requests ==');
  const sent = [];
  const client = new ZCodeProtocolClient({ exe: 'x', bundle: 'y' });
  client.child = { stdin: { writable: true, write: (s) => sent.push(JSON.parse(s)) } };
  client.exited = false;
  client._onServerRequest({ id: 'server-1', method: 'offPeak/create', params: { title: 't', prompt: 'p' } });
  await sleep(50);
  check('without handler: -32601 like the desktop without its service',
    sent.length === 1 && sent[0].id === 'server-1' && sent[0].error.code === -32601
    && /unavailable on this host/.test(sent[0].error.message), JSON.stringify(sent));
  client.offPeakHandler = async (method, params) => ({ ok: true, task: { offPeakTaskId: 'offpeak-z', title: params.title, status: 'queued', createdAt: Date.now() } });
  client._onServerRequest({ id: 'server-2', method: 'offPeak/create', params: { title: 't2', prompt: 'p' } });
  await sleep(50);
  check('with handler: result carries the task', sent.length === 2 && sent[1].result && sent[1].result.task.offPeakTaskId === 'offpeak-z');
  client.offPeakHandler = async () => { throw new Error('boom'); };
  client._onServerRequest({ id: 'server-3', method: 'offPeak/list', params: {} });
  await sleep(50);
  check('handler errors answered -32603', sent.length === 3 && sent[2].error.code === -32603 && /boom/.test(sent[2].error.message));

  console.log('== 13. cloud client: envelope + error parsing ==');
  const responses = new Map();
  const fakeFetch = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const r = responses.get(key) || { status: 200, body: '{"code":0,"data":{}}' };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (h === 'retry-after' ? r.retryAfter || null : null) },
      text: async () => r.body,
    };
  };
  const cloud = new OffPeakCloudClient({ fetchImpl: fakeFetch, loadAuth: async () => ({ jwt: 'j', codingPlanApiKey: 'k' }) });
  responses.set('GET /api/v1/off-peak/ticket/availability', { status: 200, body: JSON.stringify({ code: 0, data: { can_take_number: false, next_take_at: Math.floor(Date.now() / 1000) + 300 } }) });
  const av = await cloud.getAvailability();
  check('availability maps snake_case -> camelCase + seconds -> ms', av.canTakeNumber === false && typeof av.nextTakeAt === 'number');
  responses.set('POST /api/v1/off-peak/ticket', { status: 200, body: JSON.stringify({ code: 0, data: { ticket_id: 'w-1', state: 'ready', position: 2, next_poll_after: 30 } }) });
  const tk = await cloud.takeTicket('offpeak-x');
  check('take ticket parsed', tk.ticketId === 'w-1' && tk.state === 'ready' && tk.position === 2 && tk.nextPollAfterMs === 30000);
  responses.set('POST /api/v1/off-peak/ticket', { status: 429, body: JSON.stringify({ code: 3105, msg: 'concurrency' }), retryAfter: '20' });
  let e13 = null;
  try { await cloud.takeTicket('offpeak-x'); } catch (e) { e13 = e; }
  check('429/3105 classified rate_limited with retry-after', e13 instanceof OffPeakApiError && e13.kind === 'rate_limited'
    && e13.retryAfterMs === 20000 && /concurrency/.test(e13.message));
  responses.set('POST /api/v1/off-peak/ticket', { status: 200, body: JSON.stringify({ code: 3103, msg: 'free tier limit reached', data: { next_take_at: Math.floor(Date.now() / 1000) + 120 } }) });
  let e13b = null;
  try { await cloud.takeTicket('offpeak-x'); } catch (e) { e13b = e; }
  check('business-code 3103 in 200 envelope -> quota with nextTakeAt', e13b instanceof OffPeakApiError && e13b.kind === 'quota'
    && e13b.nextTakeAt !== null && /free tier/.test(e13b.message));

  console.log('== 14. continuation prompt matches the desktop ==');
  check('CONTINUATION_PROMPT verbatim', CONTINUATION_PROMPT.startsWith('Continue the previous task from where it left off.'));

  console.log(`\n== RESULT: ${PASS} passed, ${FAIL} failed ==`);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
