#!/usr/bin/env node
'use strict';
// LIVE test (needs the ZCode harness, no model credits): the real app-server, driven through the real MCP
// server, against a scripted mock model (test/helpers/mock-llm.cjs). Messages sent to a session while its
// turn runs:
//   1. steer: reaches the running turn after its tool step; queue: runs as its own turn afterwards, and the
//      bridge follows that turn (live stream, wait, final text);
//   2. the queue: list, edit, delete before it drains;
//   3. a stopped turn holds the queue; resume runs it;
//   4. interrupt: the running turn stops and the message starts a new one at once;
//   5. a session another ZCode process holds (as the ZCode app holds its own): a message reaches its running
//      turn through ZCode's session mailbox, the queue view shows it pending then taken, and a message not
//      taken yet can be taken back.
//   node test/steer-queue.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createMockLlm, providerConfig, MOCK_PROVIDER, MOCK_MODEL } = require('./helpers/mock-llm.cjs');

const SERVER = path.join(__dirname, '..', 'mcp-server.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passes = 0;
const check = (ok, what, extra) => {
  if (ok) { passes += 1; console.log(`  ok   ${what}`); } else { failures += 1; console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ''}`); }
};

function bridge(env, configFile) {
  const child = spawn('node', [SERVER, '--config', configFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, env) });
  let buf = ''; let id = 0; const pending = new Map(); let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-6000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
    }
  });
  const rpc = (method, params, ms = 180000) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, res);
    setTimeout(() => { if (pending.delete(myId)) rej(new Error(`timeout ${method}`)); }, ms);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = (r.result && r.result.content || []).map((c) => c.text || '').join('\n');
    return { text, s: (r.result && r.result.structuredContent) || {}, isError: !!(r.result && r.result.isError) || !!r.error, error: r.error };
  };
  return {
    call,
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-steer-queue', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    stderr: () => stderr,
    end() { child.stdin.end(); },
    exited: () => new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); }),
  };
}

(async () => {
  const mock = await createMockLlm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-steer-'));
  const providerFile = path.join(dir, 'provider_config.json');
  fs.writeFileSync(providerFile, JSON.stringify(providerConfig(mock.url), null, 2));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    model: { providerId: MOCK_PROVIDER, modelId: MOCK_MODEL },
    workspacePath: path.join(dir, 'workspace'),
    statusDir: path.join(dir, 'sessions'),
    bridgesDir: path.join(dir, 'bridges'),
    asyncByDefault: true,
    offersPollMs: 0,
  }, null, 2));
  const mailboxRoot = path.join(dir, 'mailbox');
  // ZCODE_BRIDGE_WAKE=0: a message for the stand-in app session while it is idle stays in its mailbox (the
  // real ZCode app's scheduler, or the CLI, would otherwise start a turn with it; see test/zcode-wake.cjs)
  const b = bridge({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile, ZCODE_MAILBOX_ROOT: mailboxRoot, ZCODE_BRIDGE_WAKE: '0' }, configFile);
  let app = null;
  const saw = (needle) => mock.requests.some((r) => r.lastUser.includes(needle));
  const until = async (pred, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await pred()) return true; await sleep(300); }
    console.log(`       (timed out waiting for ${label})`);
    return false;
  };
  const idle = (sid) => async () => { const w = await b.call('zcode_session_wait', { session_id: sid, timeout_s: 0 }); return w.s.status !== 'running'; };
  try {
    await b.init();

    console.log('1. steer and queue a running turn');
    const start = await b.call('zcode_session_start', { initial_prompt: 'MOCK:TOOL:8 first turn' });
    const sid = start.s.sessionId;
    check(Boolean(sid) && start.s.status === 'running', 'session started with a running turn', start.text);
    await until(() => saw('MOCK:TOOL:8 first turn'), 60000, 'the first model request');
    await sleep(800);
    const steer = await b.call('zcode_session_send', { session_id: sid, prompt: 'STEER-ONE note this' });
    check(!steer.isError && steer.s.status === 'sent' && steer.s.admitted === 'steer', 'a send to the running turn is taken as a steer', steer.text);
    const queued = await b.call('zcode_session_send', { session_id: sid, prompt: 'QUEUED-ONE run after', delivery: 'queue' });
    check(!queued.isError && queued.s.admitted === 'queue', 'delivery "queue" is queued', queued.text);
    const list1 = await b.call('zcode_session_queue', { session_id: sid });
    check(list1.s.items && list1.s.items.some((it) => it.text.includes('QUEUED-ONE')), 'the queue lists the queued message', list1.text);
    await until(() => saw('QUEUED-ONE'), 60000, 'the queued turn');
    const steerReq = mock.requests.find((r) => r.lastUser.includes('STEER-ONE'));
    const firstToolIdx = mock.requests.findIndex((r) => r.reply && r.reply.tool);
    check(Boolean(steerReq) && mock.requests.indexOf(steerReq) > firstToolIdx, 'the steer reached the model inside the first turn, after its tool step');
    await until(idle(sid), 30000, 'the queued turn to end');
    const w1 = await b.call('zcode_session_wait', { session_id: sid, timeout_s: 0 });
    check(w1.s.status === 'done' && String(w1.s.finalText || '').includes('QUEUED-ONE'), 'the bridge followed the queued turn to its final answer', JSON.stringify(w1.s).slice(0, 300));
    const stream = fs.readFileSync(path.join(dir, 'sessions', `${sid}.stream.log`), 'utf8');
    check(/steer delivered: STEER-ONE/.test(stream) && /from the queue/.test(stream) && /queued for the next turn: QUEUED-ONE/.test(stream), 'the live stream shows the steer arriving and the queued turn', stream.slice(-600));

    console.log('2. edit and delete queued messages');
    await b.call('zcode_session_send', { session_id: sid, prompt: 'MOCK:TOOL:8 second turn' });
    await until(() => saw('MOCK:TOOL:8 second turn'), 30000, 'the second turn');
    await sleep(500);
    const qa = await b.call('zcode_session_send', { session_id: sid, prompt: 'QUEUE-A original', delivery: 'queue' });
    const qb = await b.call('zcode_session_send', { session_id: sid, prompt: 'QUEUE-B dropped', delivery: 'queue' });
    check(qa.s.queueItemId && qb.s.queueItemId && qb.s.position === 2, 'two queued messages, the second at position 2', `${qa.text}\n${qb.text}`);
    const edit = await b.call('zcode_session_queue', { session_id: sid, action: 'edit', queue_item_id: qa.s.queueItemId, text: 'QUEUE-A edited' });
    check(!edit.isError && edit.s.items.some((it) => it.text === 'QUEUE-A edited'), 'edit changes a queued message', edit.text);
    const del = await b.call('zcode_session_queue', { session_id: sid, action: 'delete', queue_item_id: qb.s.queueItemId });
    check(!del.isError && !del.s.items.some((it) => it.queueItemId === qb.s.queueItemId), 'delete removes a queued message', del.text);
    await until(() => saw('QUEUE-A edited'), 40000, 'the edited queued turn');
    await until(idle(sid), 30000, 'the session to go idle');
    check(saw('QUEUE-A edited') && !saw('QUEUE-B') && !saw('QUEUE-A original'), 'only the edited message ran; the deleted one never did');

    console.log('3. a stopped turn holds the queue; resume runs it');
    await b.call('zcode_session_send', { session_id: sid, prompt: 'MOCK:TOOL:20 third turn' });
    await until(() => saw('MOCK:TOOL:20 third turn'), 30000, 'the third turn');
    await sleep(500);
    await b.call('zcode_session_send', { session_id: sid, prompt: 'QUEUE-HELD after stop', delivery: 'queue' });
    const cancel = await b.call('zcode_session_cancel', { session_id: sid });
    check(cancel.s.status === 'cancelled' && cancel.s.queue && cancel.s.queue.autoDrain === false, 'cancel stops the turn and reports the held queue', cancel.text);
    await sleep(2500);
    check(!saw('QUEUE-HELD'), 'the held message does not run by itself');
    const resume = await b.call('zcode_session_queue', { session_id: sid, action: 'resume' });
    check(!resume.isError, 'resume is accepted', resume.text);
    check(await until(() => saw('QUEUE-HELD'), 20000, 'the held turn'), 'after resume the held message runs');
    await until(idle(sid), 30000, 'the session to go idle');

    console.log('4. interrupt');
    await b.call('zcode_session_send', { session_id: sid, prompt: 'MOCK:TOOL:30 fourth turn' });
    await until(() => saw('MOCK:TOOL:30 fourth turn'), 30000, 'the fourth turn');
    await sleep(800);
    const t0 = Date.now();
    const intr = await b.call('zcode_session_send', { session_id: sid, prompt: 'INTERRUPT-NOW', delivery: 'interrupt' });
    check(!intr.isError && intr.s.delivery === 'interrupt', 'delivery "interrupt" is taken', intr.text);
    check(await until(() => saw('INTERRUPT-NOW'), 15000, 'the interrupting turn') && Date.now() - t0 < 15000, 'the interrupting message runs at once, without waiting out the 30 s tool step');
    await until(idle(sid), 30000, 'the session to go idle');
    const w4 = await b.call('zcode_session_wait', { session_id: sid, timeout_s: 0 });
    check(String(w4.s.finalText || '').includes('INTERRUPT-NOW'), 'the session ends on the interrupting turn\'s answer', JSON.stringify(w4.s).slice(0, 300));

    console.log('5. a session another process holds: the mailbox');
    // "the app": a ZCode runtime of this process, with the mailbox on, that the bridge has no record of
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = providerFile;
    process.env.ZCODE_MAILBOX_ROOT = mailboxRoot;
    const { AgentManager } = require('../lib/agent-manager.cjs');
    app = new AgentManager({ workspacePath: path.join(dir, 'app-workspace'), statusDir: path.join(dir, 'app-sessions'), model: { providerId: MOCK_PROVIDER, modelId: MOCK_MODEL } }, () => {});
    const { sessionId: appSid } = await app.createSession({});
    const appTurn = app.runTurn(appSid, 'MOCK:TOOL:10 app turn', {}).catch((e) => ({ error: e.message }));
    await until(() => saw('MOCK:TOOL:10 app turn'), 30000, 'the app session\'s turn');
    await sleep(800);
    const listed = await b.call('zcode_sessions_list', {});
    const row = (listed.s.sessions || []).find((s) => s.sessionId === appSid);
    check(Boolean(row) && row.state === 'running', 'the bridge lists the other process\'s session as running', JSON.stringify(row || listed.text).slice(0, 300));
    const ms = await b.call('zcode_session_send', { session_id: appSid, prompt: 'MAILBOX-STEER from claude' });
    check(!ms.isError && ms.s.via === 'mailbox' && ms.s.delivery === 'steer', 'a send to it goes through the mailbox as a steer', ms.text);
    const pendingView = await b.call('zcode_session_queue', { session_id: appSid });
    check((pendingView.s.mailbox || []).some((m) => m.text === 'MAILBOX-STEER from claude'), 'the queue view shows it waiting', pendingView.text);
    check(await until(() => saw('MAILBOX-STEER from claude'), 25000, 'the mailbox steer'), 'the running turn takes it');
    const steerAt = mock.requests.findIndex((r) => r.lastUser.includes('MAILBOX-STEER from claude'));
    const appToolAt = mock.requests.findIndex((r) => r.lastUser.includes('MOCK:TOOL:10 app turn') && r.reply && r.reply.tool);
    check(steerAt > appToolAt && appToolAt >= 0 && /session-message source="mailbox"/.test(mock.requests[steerAt].lastUser), 'it arrived after the tool step, as a session message');
    const takenView = await b.call('zcode_session_queue', { session_id: appSid });
    check(!(takenView.s.mailbox || []).length && (takenView.s.recentlyTaken || []).some((m) => m.text === 'MAILBOX-STEER from claude'), 'the queue view then shows it taken', takenView.text);
    const noInterrupt = await b.call('zcode_session_send', { session_id: appSid, prompt: 'x', delivery: 'interrupt' });
    check(noInterrupt.isError, 'interrupt is refused for a session the bridge reaches only by mailbox', noInterrupt.text);
    await appTurn;
    const later = await b.call('zcode_session_send', { session_id: appSid, prompt: 'TAKE-BACK me', delivery: 'queue' });
    const back = await b.call('zcode_session_queue', { session_id: appSid, action: 'delete', queue_item_id: later.s.messageId });
    check(!back.isError && !(back.s.mailbox || []).length && !fs.existsSync(path.join(mailboxRoot, appSid, 'unread', `${later.s.messageId}.json`)), 'a message not taken yet can be taken back', back.text);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${e.stack || e.message}`);
    console.log(b.stderr().slice(-2000));
  } finally {
    if (app) await app.shutdown().catch(() => {});
    b.end();
    await Promise.race([b.exited(), sleep(8000)]);
    await mock.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a file may still be open */ }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
