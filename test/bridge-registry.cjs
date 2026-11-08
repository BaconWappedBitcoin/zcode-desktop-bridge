#!/usr/bin/env node
'use strict';
/** test/bridge-registry.cjs — the registry of bridge processes (lib/bridge-registry.cjs): register, look up,
 *  tell a dead owner from a live one, and call a live owner's control endpoint (a stand-in HTTP server).
 *  Temp dirs, loopback only; no harness. Style follows test/plan-router.cjs: PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const registry = require('../lib/bridge-registry.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-registry-'));

(async () => {
  const id = registry.newOwnerId();
  check('an owner id names the process and is unique', id.startsWith(`bridge-${process.pid}-`) && id !== registry.newOwnerId());
  check('a token is long and random', registry.newToken().length >= 48 && registry.newToken() !== registry.newToken());

  // a live owner: this process, with a stand-in control endpoint
  const token = registry.newToken();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(body || '{}') });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(JSON.stringify({ error: 'unauthorized' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'from the owner' }], structuredContent: { ok: true } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  registry.register(dir, { ownerId: id, pid: process.pid, port: server.address().port, token, startedAt: new Date().toISOString() });

  const entry = registry.lookup(dir, id);
  check('a registered live owner is found', entry && entry.port === server.address().port);
  const answer = await registry.call(entry, { name: 'zcode_session_output', arguments: { session_id: 's1' } }, 5000);
  check('a call reaches the owner with its token and the tool call', seen[0] && seen[0].auth === `Bearer ${token}` && seen[0].url === '/tool' && seen[0].body.name === 'zcode_session_output' && seen[0].body.arguments.session_id === 's1');
  check('the owner\'s tool result comes back as it sent it', answer.structuredContent && answer.structuredContent.ok === true && answer.content[0].text === 'from the owner');
  let refused = null;
  try { await registry.call(Object.assign({}, entry, { token: 'wrong' }), { name: 'x' }, 5000); } catch (e) { refused = e; }
  check('a wrong token is refused (the call rejects)', refused && refused.status === 401);

  // a dead owner: a process that has exited
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(gone.stdout);
  registry.register(dir, { ownerId: 'bridge-dead', pid: deadPid, port: 1, token: 't', startedAt: new Date().toISOString() });
  check('an owner whose process exited is not found', registry.lookup(dir, 'bridge-dead') === null);
  check('an owner that never registered is not found', registry.lookup(dir, 'bridge-never') === null && registry.lookup(dir, null) === null);
  const listed = registry.list(dir);
  check('list returns live owners only, and removes the dead ones\' entries', listed.length === 1 && listed[0].ownerId === id && !fs.existsSync(path.join(dir, 'bridge-dead.json')));

  registry.unregister(dir, id);
  check('unregister removes the entry', registry.lookup(dir, id) === null);

  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
