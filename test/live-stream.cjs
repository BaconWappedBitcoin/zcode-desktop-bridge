#!/usr/bin/env node
'use strict';
/** test/live-stream.cjs — the live stream of a turn (<id>.stream.log, <id>.final.md) and bin/zcode-watch.cjs
 *  following it, over a scripted fake app-server: two model steps, a tool step between them, then the end.
 *  No harness, no network. Style follows test/plan-router.cjs: PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { AgentManager } = require('../lib/agent-manager.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-stream-'));

/** The app-server as the manager sees it: session/messages grows as the test advances the script. */
class FakeClient extends EventEmitter {
  constructor() { super(); this.running = true; this.messages = []; this.turnSession = null; this.seq = 0; this.sends = 0; }
  async sent(count) { while (this.sends < count) await sleep(20); }
  stepText(msgId, partId, text, created) {
    let m = this.messages.find((x) => x.info.id === msgId);
    if (!m) {
      m = { info: { id: msgId, role: 'assistant', semantics: { kind: 'assistant_response' }, time: { created } }, parts: [] };
      this.messages.push(m);
    }
    const part = m.parts.find((p) => p.id === partId);
    if (part) part.text = text; else m.parts.push({ id: partId, messageID: msgId, type: 'text', text });
  }
  tool(msgId, callID, status, input, error) {
    const m = this.messages.find((x) => x.info.id === msgId);
    const part = m.parts.find((p) => p.callID === callID);
    const state = { status, input, ...(error ? { error } : {}) };
    if (part) part.state = state; else m.parts.push({ id: `t-${callID}`, messageID: msgId, type: 'tool', callID, tool: 'Bash', state });
  }
  finish(status = 'completed', errorMessage) {
    const last = this.messages[this.messages.length - 1];
    last.parts.push({ id: 'sf', messageID: last.info.id, type: 'step-finish', tokens: { input: 1234, output: 56, cache: { read: 1000 } } });
    this.emit('notification', { method: 'v4/telemetry/event', params: { sessionId: this.turnSession, kind: 'turn.terminal', status, errorMessage } });
  }
  async call(method, params) {
    if (method === 'session/create') {
      this.seq += 1;
      return { session: { sessionId: `fake-${this.seq}` }, settings: { model: { available: [{ ref: { providerId: 'p', modelId: 'm' }, reasoning: { levels: [{ value: 'high' }], defaultLevel: 'high' } }] } } };
    }
    if (method === 'session/send') { this.turnSession = params.sessionId; this.messages = []; this.sends += 1; return { accepted: true }; }
    if (method === 'session/messages') return { messages: JSON.parse(JSON.stringify(this.messages)) };
    return {};
  }
}

function makeManager() {
  const dir = fs.mkdtempSync(path.join(root, 'm-'));
  fs.writeFileSync(path.join(dir, 'ZCode.exe'), '');
  fs.writeFileSync(path.join(dir, 'zcode.cjs'), '');
  const statusDir = path.join(dir, 'status');
  const mgr = new AgentManager({ zcodeExe: path.join(dir, 'ZCode.exe'), zcodeBundle: path.join(dir, 'zcode.cjs'), workspacePath: path.join(dir, 'ws'), statusDir, model: { providerId: 'p', modelId: 'm', options: { reasoningLevel: 'high' } } }, () => {});
  const fake = new FakeClient();
  fake.on('notification', (msg) => { for (const h of mgr._notificationHandlers) { try { h(msg); } catch { /* pump */ } } });
  mgr.ensureClient = async () => fake;
  mgr.client = fake;
  return { mgr, fake, statusDir };
}

function watch(statusDir, sessionId, extra = []) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'zcode-watch.cjs'), sessionId, '--status-dir', statusDir, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { out: '', code: null };
  proc.stdout.on('data', (d) => { run.out += d; });
  run.done = new Promise((resolve) => proc.on('close', (code) => { run.code = code; resolve(run); }));
  return run;
}

(async () => {
  // ------------------------------------------------------------ a turn that completes
  const { mgr, fake, statusDir } = makeManager();
  const { sessionId } = await mgr.createSession({});
  const { turnId } = mgr.startTurn(sessionId, 'Build the thing\nwith two lines', {});
  await fake.sent(1);
  const t = Date.now();
  const live = watch(statusDir, sessionId);
  const events = watch(statusDir, sessionId, ['--events']);

  fake.stepText('a1', 'p1', 'Looking at the repo.', t);
  await sleep(700);
  fake.stepText('a1', 'p1', 'Looking at the repo. Running the build next.', t);
  fake.tool('a1', 'c1', 'running', { command: 'npm run build', description: 'Build the project' });
  await sleep(700);
  fake.tool('a1', 'c1', 'error', { command: 'npm run build', description: 'Build the project' }, 'exit code 2');
  fake.tool('a1', 'c2', 'completed', { file_path: 'C:/repo/src/main.js' });
  await sleep(700);
  check('mid-turn: the live watcher has already printed the text and the tool steps', live.out.includes('Running the build next.') && live.out.includes('↳ Bash: Build the project  $ npm run build'), JSON.stringify(live.out));
  fake.stepText('a2', 'p2', 'Done: the build passes now.', t + 1);
  await sleep(700);
  fake.finish('completed');
  await sleep(1200);

  const streamFile = path.join(statusDir, `${sessionId}.stream.log`);
  const stream = fs.readFileSync(streamFile, 'utf8');
  check('the stream opens the turn with a header and the prompt on one line', stream.includes(`── turn ${turnId} started`) && stream.includes('» Build the thing with two lines'), stream);
  check('a new model step starts on a line of its own', /Running the build next\.\n[\s\S]*\nDone: the build passes now\./.test(stream), JSON.stringify(stream));
  check('a tool step is one line: its description and command', stream.includes('  ↳ Bash: Build the project  $ npm run build\n'), JSON.stringify(stream));
  check('a failed tool step says so with its error', stream.includes('  ✗ Bash: Build the project  $ npm run build — exit code 2'), JSON.stringify(stream));
  check('a tool without a description shows its path', stream.includes('  ↳ Bash: C:/repo/src/main.js'), JSON.stringify(stream));
  check('the footer gives the status, time and tokens', /── turn done \d\d:\d\d:\d\d · \d+ s · in 1234 \/ out 56 \(cache read 1000\) ──\n$/.test(stream), JSON.stringify(stream.slice(-120)));
  check('the final answer is written whole', fs.readFileSync(path.join(statusDir, `${sessionId}.final.md`), 'utf8') === 'Done: the build passes now.');
  const doc = JSON.parse(fs.readFileSync(path.join(statusDir, `${sessionId}.json`), 'utf8'));
  check('the status tail keeps the steps apart too', doc.lastOutputTail.includes('next.\n') && doc.lastOutputTail.includes('↳ Bash'), JSON.stringify(doc.lastOutputTail));

  const watched = await live.done;
  check('the watcher exits 0 when the turn is done', watched.code === 0, String(watched.code));
  check('the watcher printed the turn and then the final answer', watched.out.includes(`── turn ${turnId} started`) && /==== final answer \(.*\) ====\nDone: the build passes now\./.test(watched.out), JSON.stringify(watched.out));
  const evented = await events.done;
  const evLines = evented.out.trim().split('\n');
  check('--events prints only the turn and tool lines, then where the answer is', evented.code === 0 && !evented.out.includes('Looking at the repo') && evLines.some((l) => l.includes('↳ Bash: Build')) && evLines.some((l) => l.startsWith('── turn done')) && /done\. Full answer: .*final\.md/.test(evented.out), JSON.stringify(evented.out));

  // ------------------------------------------------------------ the next turn, then one that fails
  const second = mgr.startTurn(sessionId, 'Try something risky', {});
  await fake.sent(2);
  const failWatch = watch(statusDir, sessionId);
  fake.stepText('b1', 'q1', 'Trying.', Date.now());
  await sleep(700);
  fake.finish('failed', 'provider said no');
  const failed = await failWatch.done;
  check('a failed turn: the watcher exits 1 with the error', failed.code === 1 && /turn error: turn failed: provider said no/.test(failed.out), JSON.stringify(failed.out));
  check('the watcher follows only its own turn', !failed.out.includes('Running the build next') && failed.out.includes(`── turn ${second.turnId} started`), JSON.stringify(failed.out));

  const unknown = await watch(statusDir, 'no-such-session', ['--max-minutes', '1']).done.catch(() => null);
  check('an unknown session: exit 4 after a short wait', unknown && unknown.code === 4, unknown && JSON.stringify(unknown));

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
