'use strict';
/**
 * bridge-registry.cjs — which bridge process owns a session, and a way to reach it.
 *
 * Every client (each Claude Code session, say) runs its own bridge process, and a session lives in the
 * process that created it: its app-server, its running turn. Another process sees the session only on
 * disk (out/sessions/<id>.json). So each MCP bridge process registers itself here, in
 * <dir>/<ownerId>.json {ownerId, pid, port, token, startedAt}, serves a loopback control endpoint
 * (127.0.0.1, a random port, a random token: mcp-server.cjs), and stamps its ownerId on every session
 * status document it writes. Another process reads a session's `owner`, finds the entry, and forwards a
 * tool call to the owner; an entry whose process is gone means the owner is gone.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const newOwnerId = () => `bridge-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const newToken = () => crypto.randomBytes(24).toString('hex');

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const fileOf = (dir, ownerId) => path.join(dir, `${String(ownerId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

function register(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, entry.ownerId);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function unregister(dir, ownerId) {
  try { fs.unlinkSync(fileOf(dir, ownerId)); } catch { /* gone already */ }
}

/** The owner's entry while its process lives; null when it never registered or is gone. */
function lookup(dir, ownerId) {
  if (!ownerId) return null;
  let entry;
  try { entry = JSON.parse(fs.readFileSync(fileOf(dir, ownerId), 'utf8')); } catch { return null; }
  return alive(entry.pid) ? entry : null;
}

/** Every registered bridge, with whether its process lives; entries of dead ones are removed. */
function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    let entry;
    try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (alive(entry.pid)) out.push(entry);
    else try { fs.unlinkSync(path.join(dir, name)); } catch { /* another process cleaned it */ }
  }
  return out;
}

/** A tool call on the owner's control endpoint: resolves to the MCP tool result it returned. */
async function call(entry, body, timeoutMs = 60000) {
  const res = await fetch(`http://127.0.0.1:${entry.port}/tool`, {
    method: 'POST',
    headers: { authorization: `Bearer ${entry.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`the owner answered HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw Object.assign(new Error(parsed.error || `the owner answered HTTP ${res.status}`), { status: res.status });
  return parsed;
}

module.exports = { newOwnerId, newToken, alive, register, unregister, lookup, list, call };
