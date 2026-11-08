'use strict';
/**
 * zcode-store.cjs — a read-only view of ZCode's own session store, so a client sees every ZCode session, not
 * only those its bridge started: the desktop app's, the CLI's, other bridges'.
 *
 * ZCode keeps every session's conversation in ~/.zcode/cli/db/db.sqlite (tables session, message, part,
 * turn_usage, model_usage) and the desktop app's task list in ~/.zcode/v2/tasks-index.sqlite (table tasks).
 * Both are opened read-only; ZCode goes on writing (SQLite WAL), and every query sees its latest commit.
 *
 * A turn's turn_usage row is written when the turn ends, so a session is running when its latest user
 * prompt has no turn_usage row yet and its parts are still changing; parts unchanged for STALL_MS make it
 * "stalled" (the app quit or hung mid-turn). Needs node:sqlite (Node >= 22.5): available() says whether
 * it loaded and the store exists. Paths follow ZCODE_HOME like the rest of the bridge.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STALL_MS = 15 * 60 * 1000;

let DatabaseSync = null;
try {
  // node:sqlite announces itself as experimental once per process; keep that line out of a watcher's output
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning && warning.message || warning).includes('SQLite')) return undefined;
    return emit.call(process, warning, ...rest);
  };
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = emit;
} catch { DatabaseSync = null; }

const home = () => process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const dbPath = () => process.env.ZCODE_STORE_DB || path.join(home(), 'cli', 'db', 'db.sqlite');
const indexPath = () => process.env.ZCODE_TASK_INDEX || path.join(home(), 'v2', 'tasks-index.sqlite');

const handles = new Map();
function open(file) {
  if (!DatabaseSync || !fs.existsSync(file)) return null;
  if (!handles.has(file)) handles.set(file, new DatabaseSync(file, { readOnly: true }));
  return handles.get(file);
}
function close() {
  for (const db of handles.values()) try { db.close(); } catch { /* closed */ }
  handles.clear();
}
const available = () => Boolean(open(dbPath()));

const parse = (text) => { try { return JSON.parse(text); } catch { return {}; } };
const oneLine = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['description', 'command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'prompt']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      const extra = key === 'description' && typeof input.command === 'string' ? `  $ ${oneLine(input.command, 120)}` : '';
      return oneLine(input[key], 160) + extra;
    }
  }
  return oneLine(JSON.stringify(input), 160);
}
/** One tool step as the bridge's stream writes it. */
const toolLine = (part) => {
  const state = part.state || {};
  const failed = state.status === 'error';
  return `${failed ? '  ✗' : '  ↳'} ${part.tool || 'tool'}: ${toolSummary(state.input)}${failed && state.error ? ` — ${oneLine(state.error, 200)}` : ''}`;
};

/** The latest user prompt of a session: {id, sequence, timeCreated, text} or null. */
function latestPrompt(db, sessionId) {
  // a long turn writes one assistant message per model step: look for the user's messages by role, not by recency
  const rows = db.prepare("SELECT id, sequence, time_created, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY sequence DESC LIMIT 20").all(sessionId);
  for (const row of rows) {
    const d = parse(row.data);
    if (d.role === 'user' && (!d.semantics || d.semantics.kind === 'user_prompt')) {
      const part = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence LIMIT 5").all(row.id).map((p) => parse(p.data)).find((p) => p.type === 'text');
      return { id: row.id, sequence: row.sequence, timeCreated: row.time_created, text: part ? part.text || '' : '' };
    }
  }
  return null;
}

const TURN_STATE = { completed: 'done', error: 'error', cancelled: 'cancelled' };

/** A session's state from the store: running | stalled | done | error | cancelled | idle, with its turn's times. */
function stateOf(db, sessionId, now = Date.now()) {
  const prompt = latestPrompt(db, sessionId);
  const turn = db.prepare('SELECT turn_id, user_message_id, status, started_at, completed_at, tool_call_count, input_tokens, output_tokens FROM turn_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1').get(sessionId);
  const lastPart = db.prepare('SELECT MAX(time_updated) AS t FROM part WHERE session_id = ?').get(sessionId);
  const lastActivity = Math.max((lastPart && lastPart.t) || 0, (prompt && prompt.timeCreated) || 0);
  if (prompt && (!turn || turn.user_message_id !== prompt.id)) {
    return { state: now - lastActivity < STALL_MS ? 'running' : 'stalled', prompt, turn: null, startedAt: prompt.timeCreated, lastActivity };
  }
  if (turn) return { state: TURN_STATE[turn.status] || turn.status, prompt, turn, startedAt: turn.started_at, lastActivity };
  return { state: 'idle', prompt, turn: null, startedAt: null, lastActivity };
}

/**
 * Sessions with activity since `sinceMs`, newest first: {sessionId, title, workspace, model, source, state,
 * lastActivity, startedAt, subagent}. Subagent sessions of a ZCode session are left out unless running.
 */
function listSessions({ sinceMs = 0, limit = 50, now = Date.now() } = {}) {
  const db = open(dbPath());
  if (!db) return [];
  const index = open(indexPath());
  const rows = db.prepare('SELECT id, title, directory, time_updated, parent_id, task_type FROM session WHERE time_deleted IS NULL AND time_updated >= ? ORDER BY time_updated DESC LIMIT ?').all(sinceMs, limit * 3);
  const out = [];
  for (const row of rows) {
    const st = stateOf(db, row.id, now);
    const subagent = Boolean(row.parent_id) || row.task_type === 'subagent_child';
    if (subagent && st.state !== 'running') continue;
    const task = index ? index.prepare('SELECT title, model, task_status FROM tasks WHERE task_id = ?').get(row.id) : null;
    const model = db.prepare('SELECT model_id FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1').get(row.id);
    out.push({
      sessionId: row.id,
      title: (task && task.title) || row.title || '',
      workspace: row.directory || '',
      model: (model && model.model_id) || (task && task.model ? String(task.model).split('/').pop() : null),
      source: task ? 'the ZCode app' : 'ZCode',
      subagent,
      state: st.state,
      startedAt: st.startedAt,
      lastActivity: st.lastActivity || row.time_updated,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** One session's store entry, as listSessions would give it, or null. */
function getSession(sessionId, now = Date.now()) {
  const db = open(dbPath());
  if (!db) return null;
  const row = db.prepare('SELECT id, title, directory, time_updated, parent_id, task_type FROM session WHERE id = ?').get(sessionId);
  if (!row) return null;
  const index = open(indexPath());
  const st = stateOf(db, sessionId, now);
  const task = index ? index.prepare('SELECT title, model FROM tasks WHERE task_id = ?').get(sessionId) : null;
  const model = db.prepare('SELECT model_id FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1').get(sessionId);
  return {
    sessionId,
    title: (task && task.title) || row.title || '',
    workspace: row.directory || '',
    model: (model && model.model_id) || (task && task.model ? String(task.model).split('/').pop() : null),
    source: task ? 'the ZCode app' : 'ZCode',
    subagent: Boolean(row.parent_id) || row.task_type === 'subagent_child',
    state: st.state,
    startedAt: st.startedAt,
    lastActivity: st.lastActivity || row.time_updated,
    turn: st.turn,
    prompt: st.prompt,
  };
}

/** The parts of the latest turn (after its prompt), in order: [{id, type, text?, tool?, state?, timeUpdated}]. */
function turnParts(sessionId) {
  const db = open(dbPath());
  if (!db) return { prompt: null, parts: [] };
  const prompt = latestPrompt(db, sessionId);
  if (!prompt) return { prompt: null, parts: [] };
  const msgs = db.prepare('SELECT id, data FROM message WHERE session_id = ? AND sequence > ? ORDER BY sequence').all(sessionId, prompt.sequence);
  const parts = [];
  for (const m of msgs) {
    const md = parse(m.data);
    if (md.role !== 'assistant') continue;
    for (const p of db.prepare('SELECT id, time_updated, data FROM part WHERE message_id = ? ORDER BY sequence').all(m.id)) {
      const d = parse(p.data);
      if (d.type === 'text' || d.type === 'tool') parts.push(Object.assign({ id: p.id, messageId: m.id, timeUpdated: p.time_updated }, d));
    }
  }
  return { prompt, parts };
}

/** The latest turn as text, the way the bridge's stream file reads: prompt, text, one line per tool step. */
function turnText(sessionId, { maxLines = 25, maxChars = 3000 } = {}) {
  const { prompt, parts } = turnParts(sessionId);
  if (!prompt) return '';
  const lines = [`» ${oneLine(prompt.text, 300)}`];
  for (const p of parts) {
    if (p.type === 'tool') lines.push(toolLine(p));
    else if (p.text && p.text.trim()) lines.push(...p.text.trim().split('\n'));
  }
  return lines.slice(-maxLines).join('\n').slice(-maxChars);
}

/** The text of the turn's last assistant message: what the turn answered. */
function finalText(sessionId) {
  const { parts } = turnParts(sessionId);
  const lastMessage = parts.length ? parts[parts.length - 1].messageId : null;
  return parts.filter((p) => p.messageId === lastMessage && p.type === 'text').map((p) => p.text).join('\n');
}

/**
 * Inputs the session's runtime admitted but has not run yet: its own queue (messages typed in the app while
 * a turn ran, steers waiting for a tool step). [{inputId, delivery, text, admittedAt}], oldest first.
 */
function pendingInputs(sessionId) {
  const db = open(dbPath());
  if (!db) return [];
  return db.prepare("SELECT id, delivery, payload, time_created FROM session_input WHERE session_id = ? AND status = 'admitted' ORDER BY admitted_sequence").all(sessionId).map((r) => ({
    inputId: r.id,
    delivery: r.delivery === 'guide' ? 'steer' : r.delivery,
    text: String(parse(r.payload).text || ''),
    admittedAt: r.time_created,
  }));
}

module.exports = { available, listSessions, getSession, turnParts, turnText, finalText, pendingInputs, toolLine, close, STALL_MS, paths: () => ({ db: dbPath(), index: indexPath() }) };
