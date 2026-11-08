'use strict';
/**
 * zcode-wake.cjs — start a turn in a ZCode session nothing is running in, without forking it.
 *
 * The ZCode app keeps the sessions it has open loaded in its own runtime. A turn run by any other
 * runtime (the CLI's `--resume`, another bridge) lands in the store, but the app's loaded copy never sees
 * it, and its next turn goes on without it (measured). So a session the app may hold is woken through
 * the app itself: its scheduler (desktop scheduler process) polls ~/.zcode/v2/tasks-index.sqlite every 20 s
 * for due automations, claims them (BEGIN IMMEDIATE, running 0 → 1), and its host resumes the automation's
 * target task and sends the prompt in it, in the app's runtime, live in the app. wake() writes one
 * one-off automation for that: the session's own model, reasoning level, mode and workspace, due now.
 * When the run has settled, cleanup() removes the automation and its run rows and clears the scheduled-task
 * mark (tasks.cron_automation_id) the app put on the session, so nothing is left but the turn.
 *
 * When the ZCode app is not running, nothing holds the session: wakeByCli() runs the turn with the ZCode
 * CLI (`--resume <id> -p <text>`), in the background.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const TITLE = 'Message from Claude (zcode-bridge)';
const AUTOMATION_LIMIT = 20; // the app refuses more automations than this
const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'error', 'skipped', 'timed_out']);

let DatabaseSync = null;
try {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) { return String(w && w.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...rest); };
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = emit;
} catch { DatabaseSync = null; }

const home = () => process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const indexPath = () => process.env.ZCODE_TASK_INDEX || path.join(home(), 'v2', 'tasks-index.sqlite');
const storePath = () => process.env.ZCODE_STORE_DB || path.join(home(), 'cli', 'db', 'db.sqlite');

function openIndex() {
  if (!DatabaseSync || !fs.existsSync(indexPath())) return null;
  const db = new DatabaseSync(indexPath());
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
function withIndex(fn) {
  const db = openIndex();
  if (!db) throw new Error(`the ZCode app's task index is not available (${indexPath()})`);
  try { return fn(db); } finally { try { db.close(); } catch { /* closed */ } }
}

/** Whether the ZCode desktop app runs (its scheduler only runs with it). */
function appRunning() {
  if (process.platform !== 'win32') {
    const r = spawnSync('pgrep', ['-f', 'ZCode'], { encoding: 'utf8' });
    return r.status === 0;
  }
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /"ZCode\.exe"/i.test(r.stdout || '');
}

/** The app's task row for a session, or null (a session the app does not list: the CLI's). */
function taskOf(sessionId) {
  try { return withIndex((db) => db.prepare('SELECT * FROM tasks WHERE task_id = ? AND deleted = 0').get(sessionId) || null); } catch { return null; }
}

/** The session's current model selection {providerId, modelId, options}, from its runtime entries. */
function modelSelectionOf(sessionId, task) {
  if (DatabaseSync && fs.existsSync(storePath())) {
    const db = new DatabaseSync(storePath(), { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection' ORDER BY time_created DESC LIMIT 1").get(sessionId);
      const sel = row && JSON.parse(row.data).modelSelection;
      if (sel && sel.providerId && sel.modelId) return sel;
    } catch { /* fall back to the task row */ } finally { try { db.close(); } catch { /* closed */ } }
  }
  const m = task && /^(.+)\/([^/]+)$/.exec(String(task.model || ''));
  return m ? { providerId: m[1], modelId: m[2] } : null;
}

/**
 * Wake a session the app lists: a one-off automation targeting it, due now. Returns {automationId, dueAt}.
 * The app's scheduler picks it up within ~20 s.
 */
function wake(sessionId, prompt, { now = Date.now() } = {}) {
  const task = taskOf(sessionId);
  if (!task) throw new Error(`${sessionId} is not a task of the ZCode app`);
  const sel = modelSelectionOf(sessionId, task);
  if (!sel) throw new Error(`no model selection recorded for ${sessionId}`);
  const automationId = `automation-${crypto.randomUUID()}`;
  withIndex((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM automations').get().n);
      if (n >= AUTOMATION_LIMIT) throw new Error(`the ZCode app already has ${n} scheduled tasks (its limit is ${AUTOMATION_LIMIT})`);
      db.prepare(`INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection, mode, thought_level,
          workspace_key, workspace_path, workspace_identity, project_id, host_id, additional_directories, target_task_id,
          bot_delivery_target, location_kind, recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, scheduled_run_count, enabled, lifecycle_status, next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'local', 0, 1, NULL, NULL, 0,
          0, 0, 1, 'active', ?, NULL, 0, NULL, 'idle', 0, NULL, NULL, ?, ?)`).run(
        automationId, TITLE, '* * * * *', String(prompt), JSON.stringify(sel), task.mode || null,
        task.workspace_key, task.workspace_path, task.workspace_identity || null, task.project_id || null, task.host_id || 'local',
        task.execution_directories || null, sessionId, now, now, now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
  return { automationId, dueAt: now, model: `${sel.modelId}${sel.options && sel.options.reasoningLevel ? ` (${sel.options.reasoningLevel})` : ''}` };
}

/** Where a wake stands: pending | dispatched | running | succeeded | failed | … | gone, with the app's error. */
function wakeState(automationId) {
  return withIndex((db) => {
    const a = db.prepare('SELECT dispatch_status, lifecycle_status, last_error, target_task_id, created_at FROM automations WHERE automation_id = ?').get(automationId);
    const run = db.prepare('SELECT dispatch_status, outcome, error FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1').get(automationId);
    if (!a && !run) return { state: 'gone' };
    if (run && run.outcome) return { state: run.outcome, error: run.error || null, sessionId: a && a.target_task_id };
    if (a && a.dispatch_status === 'failed_to_dispatch') return { state: 'failed', error: a.last_error || (run && run.error) || null, sessionId: a.target_task_id };
    if (run || (a && a.dispatch_status !== 'idle')) return { state: 'dispatched', sessionId: a && a.target_task_id };
    return { state: 'pending', sessionId: a && a.target_task_id, since: a && a.created_at };
  });
}
const settled = (st) => st.state === 'gone' || TERMINAL_OUTCOMES.has(st.state) || (st.state === 'failed');

/** Remove a settled wake: its automation and run rows, and the scheduled-task mark it left on the session. */
function cleanup(automationId) {
  return withIndex((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const a = db.prepare('SELECT target_task_id, running FROM automations WHERE automation_id = ?').get(automationId);
      if (a && a.running) { db.exec('ROLLBACK'); return false; }
      db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(automationId);
      db.prepare('DELETE FROM automations WHERE automation_id = ?').run(automationId);
      db.prepare('UPDATE tasks SET cron_automation_id = NULL WHERE cron_automation_id = ?').run(automationId);
      db.exec('COMMIT');
      return true;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}

/** Every wake the bridge left (by title): [{automationId, sessionId, state, error}]. */
function listWakes() {
  try {
    return withIndex((db) => db.prepare('SELECT automation_id FROM automations WHERE title = ?').all(TITLE))
      .map((r) => Object.assign({ automationId: r.automation_id }, wakeState(r.automation_id)));
  } catch { return []; }
}

/** Clean up every settled wake (the bridge's own, by title). Returns how many were removed. */
function sweep() {
  let n = 0;
  for (const w of listWakes()) {
    if (settled(w)) {
      try { if (cleanup(w.automationId)) n += 1; } catch { /* the app holds a lock: next sweep */ }
    }
  }
  return n;
}

/**
 * The ZCode app is not running: run the turn with the ZCode CLI in the background (it resumes the session
 * from the store). Returns {pid}. `harness` = {exe, bundle, env} from lib/harness-env.cjs.
 */
function wakeByCli(sessionId, prompt, { harness, cwd, log = () => {} } = {}) {
  const args = [harness.bundle, '--resume', sessionId, '-p', String(prompt), '--json', ...(cwd ? ['--cwd', cwd] : [])];
  const child = spawn(harness.exe, args, { env: Object.assign({}, process.env, harness.env || {}, { ELECTRON_RUN_AS_NODE: '1' }), detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('cli wake failed', { sessionId, error: e.message }));
  child.unref();
  return { pid: child.pid };
}

module.exports = { TITLE, appRunning, taskOf, modelSelectionOf, wake, wakeState, settled, cleanup, listWakes, sweep, wakeByCli };
