#!/usr/bin/env node
'use strict';
// LIVE test (needs the harness; runs 3 short model turns on the default model, or on CONFIG=<config.json>):
// two bridge processes (A and B), as two Claude sessions would run them. A starts a session; B lists it,
// attaches, reads its output and sends a follow-up through A; then A exits and B takes the session over
// (session/resume) for a last follow-up that must remember what A's first turn was told (HERON-77).
//   node test/two-bridges.cjs            CONFIG=<path to a config.json> node test/two-bridges.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const SERVER = process.argv[2] || path.join(__dirname, '..', 'mcp-server.cjs');
const REPO = path.dirname(SERVER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bridge(label) {
  const child = spawn('node', [SERVER, ...(process.env.CONFIG ? ['--config', process.env.CONFIG] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = ''; let id = 0; const pending = new Map(); let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
    }
  });
  const rpc = (method, params, ms = 600000) => new Promise((res, rej) => {
    const myId = ++id; pending.set(myId, res);
    setTimeout(() => { if (pending.delete(myId)) rej(new Error(`${label}: timeout ${method}`)); }, ms);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = (r.result && r.result.content || []).map((c) => c.text || '').join('\n');
    return { text, structured: r.result && r.result.structuredContent, isError: !!(r.result && r.result.isError) };
  };
  return {
    label, child, call,
    async init() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `test-${label}`, version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    stderr: () => stderr,
    end() { child.stdin.end(); },
  };
}

async function waitDone(sessionId) {
  const statusFile = path.join(REPO, 'out', 'sessions', `${sessionId}.json`);
  for (let i = 0; i < 600; i++) {
    try { const d = JSON.parse(fs.readFileSync(statusFile, 'utf8')); if (d.status !== 'running') return d.status; } catch { /* not yet */ }
    await sleep(500);
  }
  return 'timeout';
}

const show = (label, r) => console.log(`\n### ${label}${r.isError ? ' (isError)' : ''}\n${r.text.slice(0, 1200)}`);

(async () => {
  const A = bridge('A'); const B = bridge('B');
  await A.init(); await B.init();
  await sleep(500);

  const started = await A.call('zcode_session_start', { initial_prompt: 'Remember the codeword HERON-77 for later. Reply with only: noted. No tools.', async: true });
  const sid = started.structured && started.structured.sessionId;
  show('A: zcode_session_start (async)', started);
  if (!sid) throw new Error('no sessionId');

  show('B: zcode_sessions_list (A\'s turn running)', await B.call('zcode_sessions_list', {}));
  show('B: zcode_session_attach', await B.call('zcode_session_attach', { session_id: sid }));
  console.log('\nA turn 1 ended:', await waitDone(sid));
  show('B: zcode_session_output (forwarded to A)', await B.call('zcode_session_output', { session_id: sid }));

  show('B: zcode_session_send (forwarded to A, async)', await B.call('zcode_session_send', { session_id: sid, prompt: 'Reply with only the word: second. No tools.', async: true }));
  console.log('\nturn 2 ended:', await waitDone(sid));
  show('B: zcode_session_wait timeout 0 (forwarded)', await B.call('zcode_session_wait', { session_id: sid, timeout_s: 0 }));

  A.end();
  await sleep(4000);
  show('B: zcode_sessions_list after A exited', await B.call('zcode_sessions_list', {}));
  show('B: zcode_session_attach after A exited', await B.call('zcode_session_attach', { session_id: sid }));
  show('B: zcode_session_send (takes it over)', await B.call('zcode_session_send', { session_id: sid, prompt: 'What codeword did I give you at the start? Reply with only the codeword. No tools.', async: true }));
  console.log('\nturn 3 ended:', await waitDone(sid));
  show('B: zcode_session_wait timeout 0 (now local)', await B.call('zcode_session_wait', { session_id: sid, timeout_s: 0 }));
  show('B: zcode_session_status', await B.call('zcode_session_status', { session_id: sid }));
  B.end();
  await sleep(1500);
  process.exit(0);
})().catch((e) => { console.error('test error:', e.message); process.exit(1); });
