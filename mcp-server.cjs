#!/usr/bin/env node
'use strict';
/**
 * mcp-server.cjs — expose the ZCode Windows harness as MCP tools (stdio).
 *
 * Any MCP client (Claude Code, Cline, Cursor, another ZCode instance, …) can
 * mount this server and drive full harness agent sessions as tools:
 *
 *   zcode_agent          one-shot prompt -> full agent turn -> final text
 *   zcode_session_start  create a persistent session (optional first prompt)
 *   zcode_session_send   run a follow-up turn on a session; while a turn runs: steer it,
 *                        queue the message as the next turn, or interrupt with it
 *   zcode_session_queue  a session's input queue: list, edit, delete, move, send now, pause/resume
 *   zcode_session_status inspect a session
 *   zcode_session_stop   stop a running turn
 *   zcode_session_wait   block until the current (async) turn finishes
 *   zcode_session_output peek at the latest streamed output, non-blocking
 *   zcode_session_cancel cancel the running turn (session/stop interrupt)
 *   zcode_sessions_list  every session in memory or on disk (recovery)
 *   zcode_models         list models available to the harness
 *   zcode_offpeak_create queue a FREE idle-time (off-peak) task
 *   zcode_offpeak_list   list idle-time tasks (live queue positions)
 *   zcode_offpeak_status inspect one idle-time task
 *   zcode_offpeak_models idle-time allowed models + live eligibility
 *   zcode_offpeak_cancel stop/cancel an idle-time task
 *   zcode_offpeak_pause  pause a queued idle-time task
 *   zcode_offpeak_continue resume a paused idle-time task
 *   zcode_offpeak_delete remove an idle-time task record
 *   zcode_offers         claimable plan offers (detection only — never claims)
 *
 * zcode_agent / zcode_session_start / zcode_session_send accept async:true to
 * return {sessionId, turnId, status:"running"} immediately — long turns then
 * never hit the client's tool timeout; poll with zcode_session_wait.
 *
 * Long turns emit MCP progress notifications with the latest output snippet.
 * stdout is the MCP wire (newline-delimited JSON-RPC 2.0); logs go to stderr.
 *
 * Register in ZCode (~/.zcode/cli/config.json mcp.servers) or any MCP client:
 *   { "mcpServers": { "zcode-bridge": {
 *       "command": "<ZCode.exe>",
 *       "args": ["<this file>"],
 *       "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
 */
const path = require('path');
const fs = require('fs');
const { AgentManager } = require('./lib/agent-manager.cjs');
const codingPlan = require('./lib/coding-plan.cjs');

const SUPPORTED_PROTOCOL = '2025-06-18';

function loadConfig() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (cfgPath && fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  }
  return Object.assign({ workspacePath: path.join(__dirname, 'bridge-workspace'), mode: 'yolo', turnTimeoutMs: 15 * 60 * 1000, asyncTurnTimeoutMs: 6 * 60 * 60 * 1000 }, fileCfg);
}

const cfg = loadConfig();
const log = (...a) => process.stderr.write(`[zcode-mcp] ${new Date().toISOString()} ${a.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ')}\n`);

// This process among the other bridge processes (lib/bridge-registry.cjs): every session it creates
// carries this owner id on disk, and other processes reach its sessions through the control endpoint.
const registry = require('./lib/bridge-registry.cjs');
const OWNER_ID = registry.newOwnerId();
cfg.ownerId = OWNER_ID;
const BRIDGES_DIR = path.resolve(cfg.bridgesDir || path.join(__dirname, 'out', 'bridges'));

let manager = null;
function mgr() {
  if (!manager) manager = new AgentManager(cfg, log);
  return manager;
}

let offPeak = null;
function off() {
  if (!offPeak) {
    offPeak = new (require('./lib/offpeak.cjs').OffPeakManager)({ manager: mgr(), logger: log });
    offPeak.start();
  }
  return offPeak;
}

// Offer detector: polls for claimable plan offers and toasts (config
// offersPollMs, 0 disables; offerToasts, default on). Detection only — the
// bridge NEVER claims offers (claiming needs the in-app Aliyun captcha).
// The out/offers/poller.pid lock (first-alive-wins) keeps this process and
// server.cjs from double-toasting when both run.
const offers = new (require('./lib/offers.cjs').OffersManager)({
  dir: cfg.offersDir,
  pollMs: cfg.offersPollMs,
  toasts: cfg.offerToasts !== false,
  logger: (m, x) => log('[offers]', m, x || ''),
});
offers.start();

// ------------------------------------------------------------------ wire
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function progress(token, message) {
  if (token === undefined || token === null) return;
  notify('notifications/progress', { progressToken: token, progress: 0, message: String(message).slice(0, 400) });
}

function toolResult(text, extra) {
  return Object.assign({ content: [{ type: 'text', text: String(text) }] }, extra || {});
}
function toolError(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

// ---------------------------------------------------------------- waiting without blocking
// A ZCode turn takes minutes. A client that waits on it (a blocking call, or zcode_session_wait) is held for
// all of that time. bin/zcode-watch.cjs follows a turn live and exits when it ends, so a client with
// background tasks (Claude Code: Bash run_in_background, or Monitor) waits for it while it keeps working.
// config asyncByDefault: true makes the turn-starting tools return at once unless a call says async:false.
const ASYNC_DEFAULT = cfg.asyncByDefault === true;
const WATCH_SCRIPT = path.join(__dirname, 'bin', 'zcode-watch.cjs').replace(/\\/g, '/');
const asyncOf = (args) => (args.async === undefined ? ASYNC_DEFAULT : args.async === true);
const watchCommand = (sessionId) => `node "${WATCH_SCRIPT}" ${sessionId}`;
// Claude Code hands the model a result's structuredContent, not its text: the guidance rides there too.
const waitFields = (sessionId) => ({
  watch: watchCommand(sessionId),
  howToWait: 'Run `watch` as a background task (Bash, run_in_background: true): its output is the turn live and it exits with the final answer, notifying you once. Keep working meanwhile. Do not call zcode_session_wait: it blocks this session.',
});
function backgroundHint(sessionId) {
  return [
    'ZCode is working on it in the background. Do not wait with zcode_session_wait: it blocks this whole session.',
    'To be told when the turn ends and keep working meanwhile, start this as a background task (Bash with run_in_background: true):',
    `  ${watchCommand(sessionId)}`,
    'Its output is the turn live (text and each tool step), and it exits with the full final answer: you get one notification then, and read the answer from that output.',
    'For a notification per tool step instead, run the same command with --events through the Monitor tool.',
    'Peek without waiting: zcode_session_output. Cancel: zcode_session_cancel.',
  ].join('\n');
}
const ASYNC_PARAM = `Return at once with {sessionId, turnId, status:"running"} instead of holding the call for the whole turn (default ${ASYNC_DEFAULT}). The result names a background watcher command to wait with.`;
const SERVER_INSTRUCTIONS = [
  'ZCode turns take minutes. Never hold this session on one.',
  `Start them with async (${ASYNC_DEFAULT ? 'the default here' : 'async: true'}) on zcode_agent, zcode_session_start or zcode_session_send, then wait in the background:`,
  `Bash with run_in_background: true running \`node "${WATCH_SCRIPT}" <sessionId>\`. That task's output is the turn live; it exits with the final answer and you are notified once. Keep working meanwhile.`,
  'Use the Monitor tool with the same command plus --events only when you need to react to each tool step.',
  'Do not call zcode_session_wait with a long timeout_s: it blocks the session for the whole turn.',
  'A session with a turn running takes messages too: zcode_session_send steers that turn (default), queues the message as the next turn (delivery "queue") or interrupts with it; zcode_session_queue shows and edits what waits.',
].join(' ');

const TOOLS = [
  {
    name: 'zcode_agent',
    description: `Run a one-shot agent turn in the ZCode harness (full tool access: files, shell, MCP plugins). May take minutes. ${ASYNC_DEFAULT ? 'Returns at once and runs in the background (async defaults to true here): wait with the background watcher command the result names.' : 'Without async it returns the final answer once all internal tool use completes; with async:true it returns at once and names a background watcher command to wait with.'}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task / question for the agent.' },
        workspace: { type: 'string', description: 'Optional absolute directory the agent works in (default: the bridge workspace).' },
        reasoning_level: { type: 'string', enum: ['low', 'high', 'max'], description: 'Reasoning effort (default high).' },
        model: { type: 'string', description: 'Optional model override for this call only, e.g. "GLM-5.3" (see zcode_models).' },
        async: { type: 'boolean', description: ASYNC_PARAM },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'zcode_session_start',
    description: 'Create a persistent ZCode harness session (optionally with an opening prompt) for multi-turn orchestration. Returns the sessionId; with an initial_prompt run async, also the turnId and a background watcher command to wait with.',
    inputSchema: {
      type: 'object',
      properties: {
        initial_prompt: { type: 'string', description: 'Optional first prompt; if omitted the session starts idle.' },
        workspace: { type: 'string' },
        async: { type: 'boolean', description: ASYNC_PARAM },
      },
    },
  },
  {
    name: 'zcode_session_send',
    description: 'Send a prompt to a ZCode session (a bridge\'s, or one the ZCode app holds). Idle: it runs as the next turn (run async, the call returns at once with the turnId and a background watcher command to wait with; otherwise it holds the call until the turn finishes); an idle ZCode app session is started by the app itself. A turn running: the message goes into that session the way ZCode delivers it, chosen by delivery: "steer" reaches the agent inside the running turn after its current tool step; "queue" runs as its own turn once the current one ends (queued messages run in order); "interrupt" stops the running turn and starts a new one with this message (bridge sessions only). Default: steer for a bridge\'s session; queue for a ZCode app session, where a steer can only arrive as a session message the agent sees as "for reference only" and may decline, while a queued message is a real prompt it acts on. The call returns at once; the live stream (watch command) shows the steer arriving and queued turns running.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        prompt: { type: 'string' },
        delivery: { type: 'string', enum: ['steer', 'queue', 'interrupt'], description: 'Only when a turn is running: steer, queue or interrupt. Default: steer for a bridge\'s session, queue for a ZCode app session.' },
        async: { type: 'boolean', description: ASYNC_PARAM },
      },
      required: ['session_id', 'prompt'],
    },
  },
  {
    name: 'zcode_session_queue',
    description: 'A ZCode session\'s input queue: the messages waiting to run as turns once the current one ends (and steers waiting for the next tool step). action: list (default) | edit {queue_item_id, text} | delete {queue_item_id} | move {queue_item_id, before_queue_item_id; none = to the end} | send_now {queue_item_id}: interrupt the running turn and run this item now | pause: queued items wait after turns | resume: they run again (ZCode pauses the queue when a turn is stopped).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        action: { type: 'string', enum: ['list', 'edit', 'delete', 'move', 'send_now', 'pause', 'resume'] },
        queue_item_id: { type: 'string' },
        text: { type: 'string', description: 'New text, for edit.' },
        before_queue_item_id: { type: 'string', description: 'For move: the item to place it before; omit to move it to the end.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'zcode_session_wait',
    description: 'BLOCKS the calling session for up to timeout_s: prefer the background watcher command an async start returns (Bash run_in_background), which notifies you when the turn ends while you keep working. Use this with timeout_s 0 to read a finished turn\'s result at once. Returns {status: running|done|error|cancelled (idle if no turn ever ran), finalText when done, lastOutput, usage, model}.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        timeout_s: { type: 'number', description: 'Maximum seconds to block (default 60, max 600).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'zcode_session_output',
    description: 'Peek at a session\'s latest streamed text/progress without blocking (for async turns). Returns {sessionId, status, turnId, tail}.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        tail_chars: { type: 'number', description: 'Length of the output tail to return (default 2000, capped at 2000).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'zcode_session_cancel',
    description: 'Cancel the running turn on a session: interrupts via the harness protocol\'s session/stop (the session stays usable for the next prompt) and records status "cancelled". Harmless if no turn is running.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_sessions_list',
    description: 'The ZCode sessions of every bridge process: by default the active ones (a turn running, or open in a live bridge, including those another Claude session started), running first. Each has its state (running | idle | done | error | cancelled | lost: its bridge died mid-turn), its owner (this session, another session, gone), workspace, model, last activity, its latest output line, and for a running one the watcher command to follow it live. Any of them can be used from here: zcode_session_attach, zcode_session_send, zcode_session_output and zcode_session_cancel reach a session another Claude session owns, and take over one whose owner is gone. scope "all" lists every session recorded on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['active', 'all'], description: 'active (default): running, open in a live bridge, used in the last 2 h, or lost in the last day; all: every session on disk.' },
        limit: { type: 'number', description: 'How many to list, newest first (default 20).' },
      },
    },
  },
  {
    name: 'zcode_session_attach',
    description: 'Connect to a ZCode session, wherever it runs: one this Claude session started, one another Claude session started (even mid-turn), or one whose bridge is gone. Returns its state, owner, the live tail of its current turn, and for a running turn the watcher command to follow it in the background (Bash run_in_background). From then on zcode_session_send / zcode_session_output / zcode_session_cancel work on it from here: they go to the bridge that owns it, or take it over (resume it here) when that bridge is gone.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_session_status',
    description: 'Inspect a ZCode session (busy, turns, model, age), wherever it runs.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_session_stop',
    description: 'Stop a running turn on a session.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_models',
    description: 'List models available to the harness (model id, provider, context window, reasoning levels) with the bridge\'s current default marked. Switch the default or a live session\'s model with zcode_model_set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_model_set',
    description: 'Switch the model. Without session_id: changes the bridge default used for all future agent sessions. With session_id: live-switches that existing session\'s model (its conversation and history are kept; fails if a turn is currently running on it). Accepts "GLM-5.3-Flash", "account:zai-individual-coding-plan/GLM-5.3-Flash", or {providerId, modelId} plus an optional reasoning_level.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id ("GLM-5.3-Flash") or "providerId/modelId".' },
        reasoning_level: { type: 'string', description: 'Optional: low | high | max (validated against what the model supports).' },
        session_id: { type: 'string', description: 'Optional: switch this live session instead of the default.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'zcode_plan_usage',
    description: 'Read the coding plan usage windows and banked resets: 5-hour and weekly credit windows (used/remaining/percentage/next reset time) plus how many five-hour and week resets are currently available to spend.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_reset',
    description: 'Consume one banked coding-plan reset to refresh a usage window ("five_hour" or "week"). Checks availability first and refuses without consuming when none is banked. This is a real, irreversible action on the plan account.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['five_hour', 'week'], description: 'Which window to reset.' },
        force: { type: 'boolean', description: 'Skip the availability pre-check AND the reset policy (default false).' },
        queuedWork: { type: 'boolean', description: 'Caller has GLM work queued/stalled (the reset policy requires it by default).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'zcode_plan_reset_advise',
    description: 'Dry run: should a banked 5-hour reset be spent now? Applies config.json resetPolicy (owner 2026-10-06): only when the 5-hour window is nearly exhausted, GLM work is queued, the natural reset is far enough away, and the weekly window has room. Returns spend true/false, reasons, minutesSaved (time to the natural reset) and weekly remaining. Spends nothing.',
    inputSchema: { type: 'object', properties: { queuedWork: { type: 'boolean', description: 'Caller has GLM work queued/stalled.' } } },
  },
  {
    name: 'zcode_plan_reset_opportunity',
    description: 'Ask the Z.ai backend to grant a coding-plan reset opportunity (what the desktop app earns through its reward flow). Returns granted true/false and the next-allowed time when throttled.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_route',
    description: 'Which plan currently has credit for a model (owner 2026-10-05 dynamic routing): ordered candidates per model from config.json planRouter, skipping plans without local credentials, with an exhausted 5-hour window, or under the weekly reserve kept for GLM-5.3; start plans are desktop-app only. Returns providerId (or null + waitUntil) and every candidate with its reason. Use model "auto:<modelId>" on zcode_session_start / zcode_model_set to route automatically.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'Model id, e.g. "GLM-5.3-Flash".' } }, required: ['model'] },
  },
  {
    name: 'zcode_plans',
    description: 'List every plan known to the harness (individual/team/start/off-peak coding plans), which ones this machine holds credentials for, live token availability per window (5-hour / weekly remaining, usage %, next reset) for those, and which plan is currently active for the bridge. Use zcode_plan_switch to change the active plan.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_switch',
    description: 'Switch the bridge to another plan this machine holds credentials for (see zcode_plans). Sets the plan\'s default model as the bridge default (or pick one with `model`); all future agent sessions use it. Reversible — switch back any time. Fails with a clear message for plans without local credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan provider id, e.g. "account:zai-individual-coding-plan".' },
        model: { type: 'string', description: 'Optional model id from that plan to make the default.' },
        reasoning_level: { type: 'string', description: 'Optional reasoning level for the default model.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'zcode_offpeak_create',
    description: 'Queue a FREE idle-time (off-peak) task: takes a cloud queue ticket now; the task runs unattended on spare capacity during off-peak hours at no plan-quota cost. No guaranteed start time. The prompt must be self-contained and state the deliverable explicitly — nobody answers questions during the run. The run happens in its own session (or a live bridge session when session_id is given, continuing its full history). Constraints: coding-plan subscribers only, one pending task per session, rate-limited creations (errors carry the next-allowed time), the machine must stay awake, and actions needing confirmation pause the run (prefer permission_mode yolo or plan).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise task title, no file paths (e.g. "Refactor utils directory").' },
        prompt: { type: 'string', description: 'Instructions for the unattended run. State the expected deliverable explicitly; never ask the run to create another idle-time task or automation.' },
        workspace: { type: 'string', description: 'Optional absolute directory the task works in (default: the bridge workspace).' },
        model: { type: 'string', description: 'Idle-time allowed model id (see zcode_offpeak_models); default = the newest allowed model.' },
        permission_mode: { type: 'string', enum: ['build', 'edit', 'plan', 'yolo'], description: 'Unattended run permission mode (default yolo). "plan" is read-only; "build" pauses for approval before changes.' },
        thought_level: { type: 'string', description: 'Reasoning effort for the chosen model (default: highest).' },
        session_id: { type: 'string', description: 'Optional live bridge session to bind — the run continues that conversation with its full history.' },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'zcode_offpeak_list',
    description: 'List idle-time (off-peak) tasks with live status: refreshes queue positions/ticket states from the server and mirrors every task to out/offpeak/<taskId>.json. Task status: queued|paused|running|completed|failed|cancelled; queuePosition and sessionId (once the run started) included.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Poll the server for live ticket state before listing (default true).' },
      },
    },
  },
  {
    name: 'zcode_offpeak_status',
    description: 'Inspect one idle-time task by id (local read, includes ticket state, attempts, timestamps and the on-disk status file path).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_models',
    description: 'Idle-time (off-peak) allowed models (from the harness provider registry) plus the default pick, and live eligibility: whether a task can be created right now and, when rate-limited, the next-allowed time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_offpeak_cancel',
    description: 'Cancel an idle-time task (stops a running turn, marks it cancelled, settles its queue ticket). Already-modified files are kept.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_pause',
    description: 'Pause a queued idle-time task: the poller stops dispatching it while paused. Pausing longer than the queue-wait limit expires the ticket — continuing then re-queues the task at the tail.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_continue',
    description: 'Continue a paused idle-time task (un-pauses; retakes the queue ticket automatically when the old one expired).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_delete',
    description: 'Delete an idle-time task record (cancels first when still queued/running; the on-disk status file is removed). Irreversible.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offers',
    description: 'List claimable ZCode plan offers (limited-time daily/one-time token offers the desktop app would pop up), plus banked reset opportunities, with title, token amount, period and valid-until. The bridge DETECTS and notifies only — it never claims an offer (claiming requires the in-app Aliyun captcha); claim manually in the ZCode app.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Run a live read-only check before answering (default false: return the poller\'s cached list and last check time).' },
      },
    },
  },
];

// ---------------------------------------------------------------- handlers
// ---------------------------------------------------------------- sessions of other bridge processes
// Each client runs its own bridge process, and a session lives in the one that created it. These tools
// reach a session wherever it is: in this process; through the control endpoint of the live process that
// owns it; or, when that process is gone, from disk (read-only questions) or by taking it over here
// (session/resume) for a follow-up.
const FORWARDABLE = new Set(['zcode_session_send', 'zcode_session_queue', 'zcode_session_wait', 'zcode_session_output', 'zcode_session_cancel', 'zcode_session_status', 'zcode_session_stop', 'zcode_model_set']);
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 2 * 60 * 60 * 1000;

function statusDocOf(sessionId) {
  try { return JSON.parse(fs.readFileSync(mgr().status.fileFor(sessionId), 'utf8')); } catch { return null; }
}

/** Where a session on disk is served: here, by another live bridge, by an older bridge with no control endpoint, or nowhere. */
function ownerOf(doc) {
  if (!doc) return { kind: 'unknown' };
  if (doc.owner && doc.owner === OWNER_ID) return { kind: 'here' };
  if (doc.owner) {
    const entry = registry.lookup(BRIDGES_DIR, doc.owner);
    return entry ? { kind: 'other', entry } : { kind: 'gone' };
  }
  return registry.alive(doc.pid) && doc.pid !== process.pid ? { kind: 'unreachable' } : { kind: 'gone' };
}
const OWNER_LABEL = { here: 'this Claude session', other: 'another Claude session', unreachable: 'another bridge (an older version, not reachable)', gone: 'gone (its bridge process exited)', unknown: 'unknown' };
const stateOf = (doc, owner) => (doc.status === 'running' && owner.kind === 'gone' ? 'lost' : doc.status || 'idle');

/** The current (last) turn of a session's live stream: its last lines. */
function streamTail(sessionId, maxLines = 25, maxChars = 3000) {
  let text = '';
  try { text = fs.readFileSync(mgr().status.streamFileFor(sessionId), 'utf8'); } catch { return ''; }
  const headers = [...text.matchAll(/── turn \S+ started/g)];
  const turn = headers.length ? text.slice(headers[headers.length - 1].index) : text;
  const lines = turn.trimEnd().split('\n');
  return lines.slice(-maxLines).join('\n').slice(-maxChars);
}
const lastLine = (text) => String(text || '').trim().split('\n').filter((l) => l.trim()).pop() || '';
const finalOf = (sessionId) => {
  try { return fs.readFileSync(mgr().status.finalFileFor(sessionId), 'utf8'); } catch { return ''; }
};

function forwardTimeoutMs(name, args) {
  if (name === 'zcode_session_wait') return Math.min(Math.max(Number(args.timeout_s) || 60, 0), 600) * 1000 + 15000;
  if (name === 'zcode_session_send') return asyncOf(args) ? 120000 : (cfg.turnTimeoutMs || 900000) + 30000;
  return 30000;
}

// Sessions no bridge started (the ZCode app's, the CLI's): read from ZCode's own store, read-only. Another
// process (the app) holds them, so from here they can be watched and read, not driven.
const zstore = require('./lib/zcode-store.cjs');
function storeView(entry, { tailLines = 25 } = {}) {
  const tail = zstore.turnText(entry.sessionId, { maxLines: tailLines });
  return {
    sessionId: entry.sessionId,
    state: entry.state,
    owner: entry.source,
    title: entry.title,
    workspace: entry.workspace,
    model: entry.model,
    lastActivity: entry.lastActivity ? new Date(entry.lastActivity).toISOString() : null,
    lastLine: lastLine(tail).slice(0, 200),
    ...(entry.state === 'running' ? { watch: watchCommand(entry.sessionId) } : {}),
    tail,
  };
}
// Messages reach those sessions through ZCode's session mailbox (lib/zcode-mailbox.cjs): the app's runtime
// takes them at the session's next tool step (a steer of the running turn), before a turn ends, or with the
// next prompt; it reads the mailbox only when it runs with ZCODE_MESSAGE_ENABLED=1.
const mailbox = require('./lib/zcode-mailbox.cjs');
const v4words = require('./lib/v4-commands.cjs');
// A session with no turn running is woken instead (lib/zcode-wake.cjs): through the ZCode app's scheduler
// when the app runs (the app runs the turn itself, so its loaded copy stays whole), with the ZCode CLI when
// it does not. Settled wakes are cleaned up: by this process for its own, and at startup for any left.
const wake = require('./lib/zcode-wake.cjs');
const harnessEnv = require('./lib/harness-env.cjs');
// a wake is removed once its session has finished with it: no turn running, nothing of it queued
const sessionIdle = (sid) => {
  const e = zstore.getSession(sid);
  return !e || (e.state !== 'running' && !zstore.pendingInputs(sid).length);
};
let wakeTimer = null;
function trackWake() {
  if (wakeTimer) return;
  wakeTimer = setInterval(() => {
    try { wake.sweep({ sessionIdle }); } catch { /* the app holds a lock: next round */ }
    if (!wake.pendingCount() && !wake.listWakes().length) { clearInterval(wakeTimer); wakeTimer = null; }
  }, 15000);
  if (wakeTimer.unref) wakeTimer.unref();
}
// wakes and marks an earlier bridge process left
setTimeout(() => {
  try { wake.sweep({ sessionIdle }); if (wake.pendingCount() || wake.listWakes().length) trackWake(); } catch { /* no task index */ }
}, 5000).unref();
const READ_ONLY_NOTE = 'It runs in the ZCode app, which holds it. From here: watch and read it (zcode_session_attach, zcode_session_output, the watch command) and send to it with zcode_session_send: while a turn runs, through ZCode\'s session mailbox (a steer at its next tool step; the app must run with ZCODE_MESSAGE_ENABLED=1); with no turn running, the message starts one (through the app\'s scheduler, or the ZCode CLI when the app is closed). Stop it or change its model in the app.';
const QUEUE_PREFIX = 'Queued for when you have finished your current task (do not drop what you are doing for it):\n\n';
const MAILBOX_OFF = 'The ZCode app reads the mailbox only when it runs with ZCODE_MESSAGE_ENABLED=1: set it as a user environment variable, quit ZCode fully (its tray icon too) and start it again.';

/** Pending mailbox messages of a session, each marked stuck when the session moved on without taking it. */
function mailboxPending(sid, entry) {
  return mailbox.pending(sid).map((m) => {
    const created = Date.parse(m.createdAt) || 0;
    const stuck = Boolean(entry && entry.state === 'running' && entry.lastActivity && entry.lastActivity > created + 5000);
    return { messageId: m.messageId, delivery: m.content.startsWith(QUEUE_PREFIX) ? 'queue' : 'steer', text: m.content.startsWith(QUEUE_PREFIX) ? m.content.slice(QUEUE_PREFIX.length) : m.content, createdAt: m.createdAt, ...(stuck ? { stuck: true } : {}) };
  });
}
function mailboxHint(pendingList) {
  if (pendingList.some((m) => m.stuck)) return `A message is still unread although the session went on working after it was left: the app is running without the mailbox. ${MAILBOX_OFF}`;
  return mailbox.enabledForNewProcesses() ? '' : `ZCODE_MESSAGE_ENABLED is not set for this user. ${MAILBOX_OFF} Until then messages wait in the mailbox.`;
}

function routeStore(name, sid, args = {}) {
  const entry = zstore.available() ? zstore.getSession(sid) : null;
  if (!entry) return toolError(`unknown session ${sid} (zcode_sessions_list shows the sessions of every bridge and of the ZCode app)`);
  if (name === 'zcode_session_output') {
    const view = { sessionId: sid, status: entry.state, tail: zstore.turnText(sid), owner: entry.source, note: READ_ONLY_NOTE };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  if (name === 'zcode_session_wait' || name === 'zcode_session_status') {
    const pendingList = mailboxPending(sid, entry);
    const view = { sessionId: sid, status: entry.state, title: entry.title, model: entry.model, workspace: entry.workspace, owner: entry.source, lastActivity: entry.lastActivity ? new Date(entry.lastActivity).toISOString() : null, ...(entry.state === 'done' ? { finalText: zstore.finalText(sid) } : {}), ...(entry.turn ? { usage: { input: entry.turn.input_tokens, output: entry.turn.output_tokens }, toolCalls: entry.turn.tool_call_count } : {}), ...(pendingList.length ? { mailboxPending: pendingList } : {}), note: READ_ONLY_NOTE };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  if (name === 'zcode_session_send') {
    // the app's queue (a real prompt right after the running turn) when it is reachable: the agent acts on
    // that; a mailbox steer reaches it mid-turn but as a "for reference only" session message
    const appReachable = cfg.wakeIdleSessions !== false && process.env.ZCODE_BRIDGE_WAKE !== '0' && Boolean(wake.taskOf(sid)) && wake.appRunning();
    let delivery;
    try { delivery = v4words.deliveryOf(args.delivery, entry.state === 'running' && appReachable ? 'queue' : 'guide'); } catch (e) { return toolError(e.message); }
    if (delivery === 'startNow') return toolError(`${sid} runs in the ZCode app. The bridge reaches it through ZCode's session mailbox, which delivers at tool steps, so it cannot interrupt the turn from here: stop it in the app, or send with delivery "steer" or "queue".`);
    const text = String(args.prompt || '');
    if (!text.trim()) return toolError('prompt is empty');
    // a turn runs and the message is queued: the app's scheduler hands it to the session's own queue, where it
    // runs as a real prompt once the turn ends (a mailbox message reaches the agent as a reference note)
    if (entry.state === 'running' && delivery === 'queue' && appReachable) {
      try {
        const w = wake.wake(sid, text);
        trackWake(w.automationId);
        const view = { sessionId: sid, status: 'sent', via: 'app-queue', delivery: 'queue', wakeId: w.automationId, state: entry.state, owner: entry.source, watch: watchCommand(sid), note: 'A turn is running: the ZCode app takes the message into the session\'s own queue (through its scheduler, within ~20 s) and runs it as a real prompt as soon as this turn ends.' };
        return toolResult(`Queued for ${sid} (${entry.source}, "${String(entry.title || '').slice(0, 60)}"): ${view.note}\nFollow it live: ${view.watch}`, { structuredContent: view });
      } catch (e) {
        return toolError(`queuing the message for ${sid} through the ZCode app failed: ${e.message}`);
      }
    }
    if (entry.state !== 'running' && cfg.wakeIdleSessions !== false && process.env.ZCODE_BRIDGE_WAKE !== '0') {
      // nothing runs in it: start a turn with the message
      const header = `${sid} (${entry.source}, "${String(entry.title || '').slice(0, 60)}") had no turn running`;
      const watchStart = `${watchCommand(sid)} --wait-start 120`;
      try {
        if (wake.taskOf(sid) && wake.appRunning()) {
          const w = wake.wake(sid, text);
          trackWake(w.automationId);
          const view = { sessionId: sid, status: 'sent', via: 'app-scheduler', delivery: 'turn', wakeId: w.automationId, model: w.model, state: entry.state, owner: entry.source, watch: watchStart, note: 'The ZCode app\'s scheduler starts the message as a turn in that session within ~20 s: the app runs it, so it shows there live and the app\'s copy of the session stays whole. The bridge removes the one-off scheduled task it used once the turn has run. zcode_session_queue shows it until it starts (delete takes it back).' };
          return toolResult(`${header}: the message starts a turn in it through the ZCode app's scheduler (within ~20 s, on ${w.model}). ${view.note}\nFollow it live: ${watchStart}`, { structuredContent: view });
        }
        if (!wake.appRunning()) {
          const located = harnessEnv.locateHarness(cfg);
          const run = wake.wakeByCli(sid, text, { harness: { exe: located.exe, bundle: located.bundle, env: harnessEnv.providerRuntimeEnv(located.bundle) }, cwd: entry.workspace || undefined, log });
          const view = { sessionId: sid, status: 'sent', via: 'cli', delivery: 'turn', pid: run.pid, state: entry.state, owner: entry.source, watch: watchStart, note: 'The ZCode app is not running, so nothing holds the session: the ZCode CLI runs the message as a turn in it (in the background, resumed from ZCode\'s store). The app shows it when it next opens the session.' };
          return toolResult(`${header}: the ZCode CLI runs the message as a turn in it now (pid ${run.pid}). ${view.note}\nFollow it live: ${watchStart}`, { structuredContent: view });
        }
      } catch (e) {
        return toolError(`${header}, and starting a turn failed: ${e.message}`);
      }
      // the app runs but does not list it (a session of the CLI): leave it in its mailbox
    }
    let sent;
    try { sent = mailbox.send(sid, delivery === 'queue' ? QUEUE_PREFIX + text : text); } catch (e) { return toolError(e.message); }
    const pendingList = mailboxPending(sid, entry);
    const when = entry.state === 'running'
      ? 'A turn is running: the message reaches the agent after its current tool step (or, if no tool step comes, before the turn ends). ZCode shows it to the agent as a session message marked "for reference only", which an agent may decline to act on; for an instruction it must follow, send with delivery "queue": it then runs as a real prompt right after this turn.'
      : 'No turn is running: the message arrives with the next prompt given to this session in the app (the mailbox does not wake an idle session).';
    const hint = mailboxHint(pendingList);
    const view = { sessionId: sid, status: 'sent', via: 'mailbox', delivery: delivery === 'queue' ? 'queue' : 'steer', messageId: sent.messageId, state: entry.state, owner: entry.source, pending: pendingList.length, note: [when, 'zcode_session_queue shows whether it was taken.', hint].filter(Boolean).join(' '), ...(entry.state === 'running' ? { watch: watchCommand(sid) } : {}) };
    return toolResult(`Left for ${sid} (${entry.source}, "${String(entry.title || '').slice(0, 60)}") in ZCode's session mailbox as ${view.delivery}. ${view.note}${view.watch ? `\nFollow it live: ${view.watch}` : ''}`, { structuredContent: view });
  }
  if (name === 'zcode_session_queue') {
    const action = String(args.action || 'list');
    if (action === 'delete') {
      if (!args.queue_item_id) return toolError('queue_item_id (a mailbox messageId or a wakeId from action "list") is required for delete');
      const id = String(args.queue_item_id);
      if (id.startsWith('automation-')) {
        const st = wake.wakeState(id);
        if (st.state !== 'pending') return toolError(`${id} is no longer waiting: the app's scheduler already started it (${st.state})`);
        wake.cleanup(id);
      } else {
        const taken = mailbox.cancel(sid, id);
        if (!taken) return toolError(`${id} is no longer waiting: the session already took it (or it never existed)`);
      }
    } else if (action !== 'list') {
      return toolError(`${sid} runs in the ZCode app: from here its mailbox messages can be listed and taken back (delete) before the session reads them; edit, reorder or run the app's own queue in the app.`);
    }
    const pendingList = mailboxPending(sid, entry);
    const wakes = wake.listWakes().filter((w) => w.sessionId === sid && !wake.settled(w)).map((w) => ({ wakeId: w.automationId, state: w.state, ...(w.error ? { error: w.error } : {}) }));
    const view = {
      sessionId: sid, owner: entry.source, state: entry.state,
      ...(wakes.length ? { wakes } : {}),
      mailbox: pendingList,
      recentlyTaken: mailbox.delivered(sid, 5).map((m) => ({ messageId: m.messageId, readAt: m.readAt, text: m.content.startsWith(QUEUE_PREFIX) ? m.content.slice(QUEUE_PREFIX.length) : m.content })),
      appQueue: zstore.pendingInputs(sid),
      ...(action === 'delete' ? { action, done: true } : {}),
    };
    const hint = mailboxHint(pendingList);
    const lines = [
      `${sid} (${entry.source}, ${entry.state}): ${pendingList.length ? `${pendingList.length} mailbox message(s) not taken yet` : 'no mailbox message waiting'}${view.appQueue.length ? `; ${view.appQueue.length} in the app's own queue` : ''}${action === 'delete' ? ' (delete done)' : ''}`,
      ...wakes.map((w) => `   wake ${w.wakeId}: ${w.state === 'pending' ? 'waiting for the app\'s scheduler' : w.state}${w.error ? ` — ${w.error}` : ''}`),
      ...pendingList.map((m, i) => `${i + 1}. ${m.messageId} [${m.delivery}${m.stuck ? ', not picked up' : ''}] ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`),
      ...view.appQueue.map((q) => `   app queue: [${q.delivery}] ${q.text.replace(/\s+/g, ' ').slice(0, 160)}`),
      ...view.recentlyTaken.map((m) => `   taken ${m.readAt || ''}: ${m.text.replace(/\s+/g, ' ').slice(0, 120)}`),
      hint,
    ].filter(Boolean);
    return toolResult(lines.join('\n'), { structuredContent: view });
  }
  return toolError(`${sid} runs in the ZCode app: stop it or change its model there. ${READ_ONLY_NOTE}`);
}

/** A session tool for a session this process does not hold: forwarded, answered from disk, or adopted. Returns null to go on locally. */
async function routeRemote(name, args) {
  const sid = String(args.session_id || '');
  const doc = statusDocOf(sid);
  if (!doc) return routeStore(name, sid, args);
  const owner = ownerOf(doc);
  if (owner.kind === 'other') {
    try {
      const result = await registry.call(owner.entry, { name, arguments: args }, forwardTimeoutMs(name, args));
      if (result && result.structuredContent && typeof result.structuredContent === 'object') result.structuredContent.owner = OWNER_LABEL.other;
      else if (result && Array.isArray(result.content)) result.content.push({ type: 'text', text: `\n(answered by the bridge of ${OWNER_LABEL.other}, which owns ${sid})` });
      return result;
    } catch (e) {
      return toolError(`${sid} belongs to ${OWNER_LABEL.other}, whose bridge did not answer: ${e.message}`);
    }
  }
  if (owner.kind === 'unreachable') {
    return toolError(`${sid} belongs to a bridge process (pid ${doc.pid}) of an older version with no control endpoint; use it from the Claude session that started it, or wait until that bridge exits and take it over here`);
  }
  // the owner is gone (or this process closed it): answer from disk, or take it over for a follow-up
  const state = stateOf(doc, owner);
  if (name === 'zcode_session_send' || name === 'zcode_model_set') {
    await mgr().adoptSession(sid, { workspacePath: doc.workspace, model: doc.model, turns: doc.turns || 0, fromOwner: doc.owner || `pid ${doc.pid}` });
    return null;
  }
  const lost = state === 'lost' ? 'Its bridge process exited while a turn was running; that turn ended with it. zcode_session_send continues the session here (ZCode keeps its history).' : null;
  if (name === 'zcode_session_output') {
    const view = { sessionId: sid, status: state, turnId: doc.turnId, tail: streamTail(sid) || String(doc.lastOutputTail || ''), owner: OWNER_LABEL.gone, ...(lost ? { note: lost } : {}) };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  if (name === 'zcode_session_wait') {
    const view = { sessionId: sid, turnId: doc.turnId, status: state, lastOutput: String(doc.lastOutputTail || ''), model: doc.model, owner: OWNER_LABEL.gone, ...(state === 'done' ? { finalText: finalOf(sid) || doc.finalTextTail } : {}), ...(doc.usage ? { usage: doc.usage } : {}), ...(doc.error ? { error: doc.error } : {}), ...(lost ? { note: lost } : {}) };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  if (name === 'zcode_session_status') {
    const view = Object.assign({}, doc, { state, owner: OWNER_LABEL.gone }, lost ? { note: lost } : {});
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  if (name === 'zcode_session_queue') {
    const view = { sessionId: sid, status: state, owner: OWNER_LABEL.gone, items: [], note: 'Its bridge process is gone, and its queue with it (ZCode discards queued messages when a session is resumed). zcode_session_send continues the session here.' };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }
  // cancel / stop: nothing runs
  return toolResult(`Nothing runs on ${sid}: its bridge process is gone${state === 'lost' ? ', and the turn that was running ended with it' : ''}. zcode_session_send continues the session here.`, { structuredContent: { sessionId: sid, status: state, interrupted: false } });
}

/** What zcode_session_attach and zcode_sessions_list say about one session. */
function sessionView(doc, { tailLines = 25 } = {}) {
  const local = mgr().sessionInfo(doc.id);
  const owner = local ? { kind: 'here' } : ownerOf(doc);
  const state = local ? (local.busy ? 'running' : local.status || 'idle') : stateOf(doc, owner);
  const tail = streamTail(doc.id, tailLines) || String(doc.lastOutputTail || '').slice(-1500);
  return {
    sessionId: doc.id,
    state,
    owner: OWNER_LABEL[owner.kind],
    workspace: doc.workspace,
    model: doc.model && doc.model.modelId,
    turns: doc.turns,
    turnId: doc.turnId,
    lastActivity: doc.lastActivity ? new Date(doc.lastActivity).toISOString() : null,
    lastLine: lastLine(tail).slice(0, 200),
    ...(state === 'running' ? { watch: watchCommand(doc.id) } : {}),
    tail,
  };
}

async function handleToolCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const token = params && params._meta && params._meta.progressToken;

  // a session this process does not hold: reach it where it is (a call forwarded here is always local)
  if (FORWARDABLE.has(name) && args.session_id && !params._forwarded && !mgr().sessionInfo(String(args.session_id))) {
    const routed = await routeRemote(name, args);
    if (routed) return routed;
  }

  if (name === 'zcode_agent' || name === 'zcode_session_start' || name === 'zcode_session_send') {
    progress(token, 'starting harness session…');
  }

  if (name === 'zcode_agent') {
    let modelSel;
    if (args.model) modelSel = await mgr().resolveModelSelection(String(args.model), { reasoningLevel: args.reasoning_level });
    const { sessionId, model } = await mgr().createSession({
      workspacePath: args.workspace,
      reasoningLevel: args.reasoning_level,
      ...(modelSel ? { model: modelSel } : {}),
    });
    if (asyncOf(args)) {
      const started = mgr().startTurn(sessionId, String(args.prompt || ''), {});
      const text = `sessionId: ${sessionId}\nturnId: ${started.turnId}\nstatus: running\nmodel: ${model.providerId}/${model.modelId}\n\n${backgroundHint(sessionId)}`;
      return toolResult(text, { structuredContent: { sessionId, turnId: started.turnId, status: 'running', model, ...waitFields(sessionId) } });
    }
    try {
      const result = await mgr().runTurn(sessionId, String(args.prompt || ''), {
        onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
      });
      const parts = [];
      if (result.reasoning) parts.push(`[reasoning]\n${result.reasoning}\n\n[answer]`);
      parts.push(result.text || '(no textual output)');
      parts.push(`\n\n[model] ${model.providerId}/${model.modelId}`);
      parts.push(`\n[usage] input=${result.usage.input || 0} output=${result.usage.output || 0} cacheRead=${(result.usage.cache && result.usage.read) || 0}`);
      return toolResult(parts.join('\n'), { structuredContent: { sessionId, model, text: result.text, reasoning: result.reasoning, usage: result.usage, finishReason: result.finishReason } });
    } finally {
      // one-shot sessions are disposable; leave reaping to the idle timer
    }
  }

  if (name === 'zcode_session_start') {
    const created = await mgr().createSession({ workspacePath: args.workspace });
    if (args.initial_prompt) {
      if (asyncOf(args)) {
        const started = mgr().startTurn(created.sessionId, String(args.initial_prompt), {});
        return toolResult(`sessionId: ${created.sessionId}\nturnId: ${started.turnId}\nstatus: running\n\n${backgroundHint(created.sessionId)}`, { structuredContent: { sessionId: created.sessionId, turnId: started.turnId, status: 'running', model: created.model, ...waitFields(created.sessionId) } });
      }
      progress(token, 'running opening prompt…');
      const result = await mgr().runTurn(created.sessionId, String(args.initial_prompt), {
        onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
      });
      return toolResult(`sessionId: ${created.sessionId}\nmodel: ${created.model.providerId}/${created.model.modelId}\n\n${result.text || ''}`, { structuredContent: { sessionId: created.sessionId, model: created.model, firstReply: result.text } });
    }
    return toolResult(`sessionId: ${created.sessionId}\nmodel: ${created.model.providerId}/${created.model.modelId}\n(idle, awaiting prompts)`, { structuredContent: { sessionId: created.sessionId, model: created.model } });
  }

  if (name === 'zcode_session_send') {
    const info = mgr().sessionInfo(String(args.session_id || ''));
    if (!info) return toolError(`unknown session ${args.session_id} (start one with zcode_session_start, or recover it with zcode_sessions_list)`);
    if (info.busy) {
      // a turn runs: steer it, queue the message, or interrupt with it (V4 sendText delivery)
      const sid = String(args.session_id);
      let sent;
      try { sent = await mgr().sendInput(sid, String(args.prompt || ''), { delivery: args.delivery }); } catch (e) { return toolError(e.message); }
      const how = {
        steer: 'It reaches the agent inside the running turn after its current tool step (if the turn ends first, ZCode runs it as the next turn instead).',
        queue: `It runs as its own turn when the current one ends${sent.position ? ` (position ${sent.position} in the queue)` : ''}.`,
        interrupt: 'The running turn was interrupted; this message starts a new turn now.',
      }[sent.admitted] || `ZCode took it as ${sent.admitted}.`;
      const text = `Sent to ${sid} while its turn runs (${sent.delivery}${sent.admitted !== sent.delivery ? `, delivered as ${sent.admitted}` : ''}). ${how}\nFollow it live: ${watchCommand(sid)}${sent.queue.items.length ? `\nQueue: ${sent.queue.items.map((it) => `${it.queueItemId} [${it.delivery}] ${it.text.slice(0, 60)}`).join(' | ')}` : ''}`;
      return toolResult(text, { structuredContent: Object.assign({ status: 'sent' }, sent, waitFields(sid)) });
    }
    if (asyncOf(args)) {
      const started = mgr().startTurn(String(args.session_id), String(args.prompt || ''), {});
      return toolResult(`sessionId: ${args.session_id}\nturnId: ${started.turnId}\nstatus: running\n\n${backgroundHint(String(args.session_id))}`, { structuredContent: Object.assign({}, started, waitFields(String(args.session_id))) });
    }
    const result = await mgr().runTurn(String(args.session_id), String(args.prompt || ''), {
      onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
    });
    return toolResult(result.text || '(no textual output)', { structuredContent: { text: result.text, usage: result.usage, finishReason: result.finishReason } });
  }

  if (name === 'zcode_session_queue') {
    const sid = String(args.session_id || '');
    if (!mgr().sessionInfo(sid)) return toolError(`unknown session ${sid} (recover it with zcode_sessions_list)`);
    const action = String(args.action || 'list');
    let view;
    try {
      view = action === 'list'
        ? mgr().queueView(sid)
        : await mgr().queueOp(sid, action, { queueItemId: args.queue_item_id, text: args.text, beforeQueueItemId: args.before_queue_item_id });
    } catch (e) {
      return toolError(e.message);
    }
    const lines = view.items.map((it, i) => `${i + 1}. ${it.queueItemId} [${it.delivery}${it.state !== 'queued' ? `, ${it.state}` : ''}] ${it.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    const head = `${sid}: ${view.items.length ? `${view.items.length} waiting` : 'queue empty'}${view.running ? ', a turn is running' : ''}${view.autoDrain ? '' : `; paused (${view.paused}) — action "resume" runs the queue again`}${action !== 'list' ? ` (${action} done)` : ''}`;
    return toolResult([head, ...lines].join('\n'), { structuredContent: view });
  }

  if (name === 'zcode_session_wait') {
    const sid = String(args.session_id || '');
    if (!mgr().sessionInfo(sid)) return toolError(`unknown session ${sid} (recover it with zcode_sessions_list)`);
    let timeoutS = Number(args.timeout_s);
    if (!Number.isFinite(timeoutS)) timeoutS = 60;
    timeoutS = Math.max(0, Math.min(timeoutS, 600));
    const view = await mgr().waitTurn(sid, timeoutS * 1000);
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }

  if (name === 'zcode_session_output') {
    const sid = String(args.session_id || '');
    let tailChars = Number(args.tail_chars);
    if (!Number.isFinite(tailChars) || tailChars < 0) tailChars = 2000;
    tailChars = Math.min(tailChars, 2000);
    let out;
    try { out = mgr().sessionOutput(sid); } catch (e) { return toolError(e.message); }
    const view = { sessionId: out.sessionId, status: out.status, turnId: out.turnId, tail: String(out.tail).slice(-tailChars) };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }

  if (name === 'zcode_session_cancel') {
    const result = await mgr().cancelTurn(String(args.session_id || ''));
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_sessions_list') {
    const all = args.scope === 'all';
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 500));
    const now = Date.now();
    const views = [];
    for (const doc of mgr().sessionsList()) {
      if (!doc || !doc.id) continue;
      const view = sessionView(doc, { tailLines: 6 });
      delete view.tail;
      const open = view.state === 'running' || (!doc.closed && /this Claude session|another Claude session/.test(view.owner));
      const recentlyLost = view.state === 'lost' && now - (doc.lastActivity || 0) < DAY_MS;
      // used in the last two hours, whoever owns it (a session with no turn is a throwaway, e.g. zcode_models')
      const recent = (doc.turns || 0) > 0 && now - (doc.lastActivity || 0) < RECENT_MS;
      if (!all && !open && !recentlyLost && !recent) continue;
      views.push(view);
    }
    // and the sessions no bridge started: the ZCode app's, the CLI's (ZCode's own store, read-only)
    if (zstore.available()) {
      const known = new Set(views.map((v) => v.sessionId));
      for (const entry of zstore.listSessions({ sinceMs: all ? 0 : now - RECENT_MS, limit: all ? limit : 50, now })) {
        if (known.has(entry.sessionId)) continue;
        const view = storeView(entry, { tailLines: 6 });
        delete view.tail;
        views.push(view);
      }
    }
    const rank = (v) => (v.state === 'running' ? 0 : v.state === 'lost' || v.state === 'stalled' ? 1 : 2);
    views.sort((a, b) => rank(a) - rank(b) || String(b.lastActivity).localeCompare(String(a.lastActivity)));
    const shown = views.slice(0, limit);
    const lines = shown.map((v) => `${v.sessionId}  ${v.state.padEnd(9)} ${v.owner}  ${v.model || '?'}  ${v.title ? `"${String(v.title).slice(0, 60)}"  ` : ''}${v.workspace || ''}  last ${v.lastActivity || '?'}${v.lastLine ? `\n    ${v.lastLine}` : ''}${v.watch ? `\n    follow live: ${v.watch}` : ''}`);
    const head = all ? `${views.length} sessions` : `${views.length} active sessions (running, open in a live bridge, used in the last 2 h, or lost in the last day; bridges' and the ZCode app's)`;
    const text = [head + (views.length > shown.length ? `, ${shown.length} shown` : ''), ...lines, views.length === 0 && !all ? 'None. scope "all" lists every session on disk.' : ''].filter(Boolean).join('\n');
    return toolResult(text, { structuredContent: { scope: all ? 'all' : 'active', count: views.length, sessions: shown } });
  }

  if (name === 'zcode_session_attach') {
    const sid = String(args.session_id || '');
    const local = mgr().sessionInfo(sid);
    const doc = statusDocOf(sid) || (local ? { id: sid, workspace: local.workspacePath, model: local.model, turns: local.turns, turnId: local.turnId, lastActivity: local.lastActivity, lastOutputTail: local.lastOutputTail } : null);
    if (!doc) {
      const entry = zstore.available() ? zstore.getSession(sid) : null;
      if (!entry) return toolError(`unknown session ${sid} (zcode_sessions_list shows the sessions of every bridge and of the ZCode app)`);
      const view = storeView(entry);
      view.howToUse = `${READ_ONLY_NOTE}${view.watch ? ' A turn is running: follow it without blocking by running `watch` as a background task (Bash, run_in_background: true); you are notified when it ends.' : ''}`;
      const text = [`${sid}: ${view.state}, ${view.owner}, ${view.model || '?'} "${view.title}" in ${view.workspace || '?'}`, view.howToUse, view.tail ? `--- current turn ---\n${view.tail}` : '(no output recorded)'].join('\n');
      return toolResult(text, { structuredContent: view });
    }
    const view = sessionView(doc);
    const how = view.owner === OWNER_LABEL.here
      ? 'It runs in this Claude session\'s bridge.'
      : view.owner === OWNER_LABEL.other
        ? 'Another Claude session owns it: zcode_session_send, zcode_session_output and zcode_session_cancel from here go to its bridge.'
        : view.owner === OWNER_LABEL.unreachable
          ? 'An older bridge version owns it and cannot be reached; its live stream can still be followed.'
          : `Its bridge is gone${view.state === 'lost' ? ' (it exited mid-turn; that turn ended with it)' : ''}: zcode_session_send takes it over here and continues the conversation.`;
    view.howToUse = view.watch
      ? `${how} A turn is running: follow it without blocking by running \`watch\` as a background task (Bash, run_in_background: true); you are notified when it ends.`
      : how;
    const text = [`${sid}: ${view.state}, owner ${view.owner}, ${view.model || '?'} in ${view.workspace || '?'}`, view.howToUse, view.tail ? `--- current turn ---\n${view.tail}` : '(no output recorded)'].join('\n');
    return toolResult(text, { structuredContent: view });
  }

  if (name === 'zcode_session_status') {
    const info = mgr().sessionInfo(String(args.session_id || ''));
    if (!info) return toolError(`unknown session ${args.session_id}`);
    const { lastOutputTail, finalTextTail, streamPart, streamAtLineStart, ...rest } = info;
    return toolResult(JSON.stringify(Object.assign(rest, { owner: OWNER_LABEL.here, lastLine: lastLine(lastOutputTail) }), null, 2));
  }

  if (name === 'zcode_session_stop') {
    await mgr().stopSession(String(args.session_id || ''));
    return toolResult('stop requested');
  }

  if (name === 'zcode_models') {
    const models = await mgr().listModels();
    const def = mgr().defaultModel;
    const payload = models.map((m) => ({
      modelId: m.ref && m.ref.modelId,
      providerId: m.ref && m.ref.providerId,
      label: m.label,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      reasoning: m.reasoning,
      isDefault: !!(m.ref && def && m.ref.providerId === def.providerId && m.ref.modelId === def.modelId),
    }));
    return toolResult(JSON.stringify({ default: def, models: payload }, null, 2), { structuredContent: { default: def, models: payload } });
  }

  if (name === 'zcode_model_set') {
    const ref = String(args.model || '').trim();
    if (!ref) return toolError('model is required (see zcode_models)');
    if (args.session_id) {
      const updated = await mgr().setSessionModel(String(args.session_id), ref, { reasoningLevel: args.reasoning_level });
      return toolResult(`session ${args.session_id} now uses ${updated.providerId}/${updated.modelId} (reasoning: ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { scope: 'session', sessionId: args.session_id, model: updated } });
    }
    const updated = await mgr().setDefaultModel(ref, { reasoningLevel: args.reasoning_level });
    return toolResult(`bridge default model is now ${updated.providerId}/${updated.modelId} (reasoning: ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { scope: 'default', model: updated } });
  }

  if (name === 'zcode_plan_usage') {
    const snap = await codingPlan.getPlanSnapshot();
    return toolResult(JSON.stringify(snap, null, 2), { structuredContent: snap });
  }

  if (name === 'zcode_plan_reset_advise') {
    const snap = await codingPlan.getPlanSnapshot();
    const advice = require('./lib/reset-policy.cjs').evaluate(snap, cfg.resetPolicy, { queuedWork: args.queuedWork === true });
    return toolResult(JSON.stringify(advice, null, 2), { structuredContent: advice });
  }

  if (name === 'zcode_plan_reset') {
    const type = String(args.type || '');
    if (args.force !== true && (type === 'five_hour' || type === 'FIVE_HOUR')) {
      const snap = await codingPlan.getPlanSnapshot();
      const advice = require('./lib/reset-policy.cjs').evaluate(snap, cfg.resetPolicy, { queuedWork: args.queuedWork === true });
      if (!advice.spend) {
        const refused = { used: false, refusedByPolicy: true, advice };
        return toolResult(JSON.stringify(refused, null, 2), { structuredContent: refused });
      }
    }
    const result = await codingPlan.useReset(type, { force: args.force === true });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_reset_opportunity') {
    const result = await codingPlan.requestOpportunity();
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_route') {
    if (!args.model) return toolError('model is required');
    const result = await require('./lib/plan-router.cjs').route(String(args.model), { policy: cfg.planRouter });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plans') {
    const result = await codingPlan.listPlans(mgr().defaultModel.providerId);
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_switch') {
    if (!args.plan) return toolError('plan is required (see zcode_plans for ids)');
    const updated = await mgr().setPlan(String(args.plan), {
      modelId: args.model ? String(args.model) : undefined,
      reasoningLevel: args.reasoning_level,
    });
    return toolResult(`active plan is now ${updated.providerId} (default model ${updated.modelId}, reasoning ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { plan: updated.providerId, model: updated } });
  }

  if (name === 'zcode_offpeak_create') {
    const task = await off().create({
      title: args.title,
      prompt: args.prompt,
      workspace: args.workspace,
      model: args.model,
      permissionMode: args.permission_mode,
      thoughtLevel: args.thought_level,
      sessionId: args.session_id,
    });
    const pos = typeof task.queuePosition === 'number' ? ` (#${task.queuePosition} in queue)` : '';
    const text = `Created idle-time task ${task.offPeakTaskId}${pos}.\nstatus: ${task.status}\nmodel: ${task.model.providerId}/${task.model.modelId}\nworkspace: ${task.workspace}\nstatus file: ${off().store.fileFor(task.offPeakTaskId)}\nTrack with zcode_offpeak_list; it runs unattended when off-peak capacity is granted (keep the machine awake).`;
    return toolResult(text, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_list') {
    const result = await off().list({ refresh: args.refresh !== false });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offpeak_status') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().get(String(args.task_id));
    return toolResult(JSON.stringify(task, null, 2), { structuredContent: task });
  }

  if (name === 'zcode_offpeak_models') {
    const models = off().allowedModels();
    const def = models.find((m) => m.isDefault) || models[models.length - 1] || null;
    let availability = null;
    let availabilityError = null;
    try { availability = await off().availability(); }
    catch (e) { availabilityError = e.describe ? e.describe() : e.message; }
    const result = { default: def ? { providerId: def.providerId, modelId: def.modelId } : null, models, availability, availabilityError };
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offpeak_cancel') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().cancel(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_pause') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().pause(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_continue') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().continue(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_delete') {
    if (!args.task_id) return toolError('task_id is required');
    const result = await off().delete(String(args.task_id));
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offers') {
    const result = await offers.list({ refresh: args.refresh === true });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  return toolError(`unknown tool: ${name}`);
}

// ------------------------------------------------------------------ control endpoint for other bridges
// 127.0.0.1, a random port, a random token, both in this process's registry entry. Answers only the
// session tools, and only for sessions this process holds.
const CONTROL_TOKEN = registry.newToken();
const control = require('http').createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${CONTROL_TOKEN}`) return send(401, { error: 'unauthorized' });
  if (req.method !== 'POST' || req.url !== '/tool') return send(404, { error: 'unknown path' });
  let text = '';
  for await (const chunk of req) text += chunk;
  let body;
  try { body = JSON.parse(text); } catch { return send(400, { error: 'the body is not JSON' }); }
  const name = body && body.name;
  const callArgs = (body && body.arguments) || {};
  if (!FORWARDABLE.has(name)) return send(403, { error: `${name} is not answered for other bridges` });
  if (!manager || !manager.sessionInfo(String(callArgs.session_id || ''))) return send(404, { error: `session ${callArgs.session_id} is not held by this bridge (any more)` });
  try {
    send(200, await handleToolCall({ name, arguments: callArgs, _forwarded: true }));
  } catch (e) {
    send(500, { error: e.message });
  }
});
control.on('error', (e) => log('control endpoint error', e.message));
control.listen(0, '127.0.0.1', () => {
  try {
    registry.register(BRIDGES_DIR, { ownerId: OWNER_ID, pid: process.pid, port: control.address().port, token: CONTROL_TOKEN, startedAt: new Date().toISOString(), kind: 'mcp' });
  } catch (e) { log('bridge registry write failed', e.message); }
});
control.unref();
process.on('exit', () => registry.unregister(BRIDGES_DIR, OWNER_ID));

// ------------------------------------------------------------------ loop
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) dispatch(JSON.parse(line)).catch((e) => log('dispatch error', e.message));
  }
});
process.stdin.on('end', () => { log('stdin closed, exiting'); shutdown(); });

// What the client declared (initialize) and sent along with its last tools/call (_meta), for diagnosing
// what it supports: out/mcp-client.json. Capabilities and metadata keys only, never arguments.
const CLIENT_FILE = path.join(__dirname, 'out', 'mcp-client.json');
const clientSeen = { initialize: null, lastCallMeta: null };
function recordClient(key, value) {
  clientSeen[key] = value;
  try {
    fs.mkdirSync(path.dirname(CLIENT_FILE), { recursive: true });
    fs.writeFileSync(CLIENT_FILE, `${JSON.stringify(clientSeen, null, 2)}\n`);
  } catch { /* diagnostics only */ }
}

let initialized = false;
async function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined) {
    // notification
    if (msg.method === 'notifications/initialized') initialized = true;
    return;
  }
  if (msg.method === 'initialize') {
    const p = msg.params || {};
    recordClient('initialize', { at: new Date().toISOString(), protocolVersion: p.protocolVersion, capabilities: p.capabilities, clientInfo: p.clientInfo, metaKeys: Object.keys(p._meta || {}) });
    const clientProto = msg.params && msg.params.protocolVersion;
    const protocolVersion = clientProto || SUPPORTED_PROTOCOL;
    return reply(msg.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'zcode-bridge', version: '0.5.2', title: 'ZCode harness bridge' },
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.method === 'tools/list') {
    return reply(msg.id, { tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    const meta = (msg.params && msg.params._meta) || {};
    recordClient('lastCallMeta', { at: new Date().toISOString(), tool: msg.params && msg.params.name, meta: Object.fromEntries(Object.entries(meta).filter(([k]) => /capabilit|protocolVersion|progressToken/i.test(k))), keys: Object.keys(meta) });
    try {
      const result = await handleToolCall(msg.params);
      return reply(msg.id, result);
    } catch (e) {
      log('tool call failed', e.message);
      return reply(msg.id, toolError(e.message));
    }
  }
  if (msg.method === 'resources/list') return reply(msg.id, { resources: [] });
  if (msg.method === 'prompts/list') return reply(msg.id, { prompts: [] });
  return replyErr(msg.id, -32601, `method not found: ${msg.method}`);
}

async function shutdown() {
  offers.stop();
  if (manager) await manager.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('zcode-bridge MCP server ready on stdio');
