'use strict';
/**
 * zcode-mailbox.cjs — ZCode's session mailbox: how a message reaches a session that another process holds
 * (the ZCode app's sessions), locally, with no protocol connection to that process.
 *
 * A ZCode runtime started with ZCODE_MESSAGE_ENABLED=1 reads <root>/<sessionId>/unread/*.json (root:
 * ZCODE_MAILBOX_ROOT, default ~/.zcode/mailbox), in name order, at three points of each session's turns,
 * and moves each file it takes to read/:
 *   - after a tool step: the message becomes a steer of the running turn (the model gets it before its
 *     next step);
 *   - when a turn would end: added as context, and the turn goes on;
 *   - when a prompt is submitted: added as context to that prompt.
 * Nothing wakes an idle session: a message for one waits until its next prompt. The model sees each message
 * as <session-message source="mailbox" from_session=…>…</session-message>.
 * Envelope: {version: 1, messageId, fromSessionId, toSessionId, content, createdAt}, all strings. Files are
 * written as .json.tmp and renamed, so the reader never takes a half-written one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SESSION_RE = /^(?:sess|session)_[A-Za-z0-9._-]+$/;
const root = () => process.env.ZCODE_MAILBOX_ROOT || path.join(os.homedir(), '.zcode', 'mailbox');
const dirOf = (sessionId, box) => path.join(root(), sessionId, box);

function checkId(sessionId) {
  if (!SESSION_RE.test(String(sessionId || ''))) throw new Error(`not a ZCode session id: ${sessionId}`);
  return String(sessionId);
}

/** Leave a message for a session. Returns {messageId, file}. */
function send(sessionId, content, { from = 'session_claude-code', now = Date.now() } = {}) {
  const sid = checkId(sessionId);
  const dir = dirOf(sid, 'unread');
  fs.mkdirSync(dir, { recursive: true });
  // the name sorts by time: the reader takes messages in name order
  const messageId = `${String(now).padStart(14, '0')}-${crypto.randomBytes(4).toString('hex')}`;
  const envelope = { version: 1, messageId, fromSessionId: String(from), toSessionId: sid, content: String(content), createdAt: new Date(now).toISOString() };
  const file = path.join(dir, `${messageId}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(envelope));
  fs.renameSync(`${file}.tmp`, file);
  return { messageId, file };
}

function readBox(sessionId, box) {
  let names = [];
  try { names = fs.readdirSync(dirOf(sessionId, box)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dirOf(sessionId, box), name);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      let movedAt = null;
      if (box === 'read') try { movedAt = fs.statSync(file).mtimeMs; } catch { /* gone */ }
      out.push({ messageId: e.messageId, from: e.fromSessionId, content: e.content, createdAt: e.createdAt, file, ...(movedAt ? { readAt: new Date(movedAt).toISOString() } : {}) });
    } catch { /* not ours / half-written */ }
  }
  return out;
}

/** Messages the session has not taken yet, oldest first. */
const pending = (sessionId) => (SESSION_RE.test(String(sessionId || '')) ? readBox(sessionId, 'unread') : []);
/** Messages the session took (the runtime moved them to read/), newest last; `limit` newest. */
const delivered = (sessionId, limit = 10) => (SESSION_RE.test(String(sessionId || '')) ? readBox(sessionId, 'read').slice(-limit) : []);

/** unread | read | missing */
function stateOf(sessionId, messageId) {
  if (fs.existsSync(path.join(dirOf(sessionId, 'unread'), `${messageId}.json`))) return 'unread';
  if (fs.existsSync(path.join(dirOf(sessionId, 'read'), `${messageId}.json`))) return 'read';
  return 'missing';
}

/** Take back a message the session has not read yet. True if it was still unread. */
function cancel(sessionId, messageId) {
  const file = path.join(dirOf(checkId(sessionId), 'unread'), `${String(messageId).replace(/[\\/]/g, '')}.json`);
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * Whether ZCode processes started from now on get ZCODE_MESSAGE_ENABLED (the user's environment). A running
 * ZCode app read its environment when it started: this does not tell whether it has the mailbox on.
 */
function enabledForNewProcesses() {
  const on = (v) => /^(1|true)$/i.test(String(v || '').trim());
  if (process.platform === 'win32') {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'ZCODE_MESSAGE_ENABLED'], { encoding: 'utf8', windowsHide: true });
    const m = /ZCODE_MESSAGE_ENABLED\s+REG_\w+\s+(\S+)/.exec(r.stdout || '');
    if (m) return on(m[1]);
  }
  return on(process.env.ZCODE_MESSAGE_ENABLED);
}

module.exports = { send, pending, delivered, stateOf, cancel, enabledForNewProcesses, root, SESSION_RE };
