'use strict';
/**
 * offpeak.cjs — Z.ai idle-time ("off-peak") tasks for the bridge.
 *
 * Verified against the ZCode desktop (resources/app.asar host/index.js) and
 * the agent bundle (resources/glm/zcode.cjs):
 *
 *  - The app-server has NO offPeak RPCs (live probe: client->server
 *    "offPeak/list" / "offPeak/create" both return -32601). Instead
 *    "offPeak/create" / "offPeak/list" are server->CLIENT requests: the agent
 *    tools OffPeakCreate/OffPeakList forward to the host, which owns the task
 *    store. This module IS that host for the bridge.
 *
 *  - Cloud ticket API (base {planOrigin}/api/v1/off-peak, auth = zcode JWT +
 *    coding-plan api key; all verified live):
 *      GET  /ticket/availability      -> {can_take_number, next_take_at?}
 *      POST /ticket          {task_id}          -> {ticket_id, state, position?, next_poll_after?}
 *      POST /ticket/status   {ticket_ids:[...]} -> {next_poll_after?, tickets:[{ticket_id, state, position?, active_deadline?}]}
 *      POST /ticket/<id>/settle                  -> ack
 *    ticket state: queued|ready|active|expired|settled|not_found.
 *    Business codes: 3101 eligibility, 3103 free-tier quota (next_take_at),
 *    3105 / HTTP 429 concurrency, 3102/3001 ticket expired.
 *
 *  - The run: when a ticket turns "ready", the desktop sends the prompt with
 *    modelSelection = the off-peak provider and modelExecution.requestAuth =
 *    {apiKey: jwt, headers: {Authorization, X-Coding-Plan-Api-Key,
 *    X-Off-Peak-Ticket-ID}} — that ticket header is what bills the free
 *    off-peak pool instead of plan quota. session/send accepts exactly these
 *    params (offPeakTaskId, offPeakRunType "init"|"resume", toolDenylist,
 *    modelExecution requiring modelSelection).
 *
 *  - Allowed idle models come from the builtin provider registry: providers
 *    with access.mode "off-peak" (account:zai-offpeak-idle-plan,
 *    account:bigmodel-offpeak-idle-plan); default model = last registry entry
 *    (the "newest"). Coding-plan subscribers only; machine must stay awake;
 *    runs only during off-peak hours; permission prompts pause the run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SessionStatusStore } = require('./session-status.cjs');
const harnessEnv = require('./harness-env.cjs');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TICKET_TERMINAL = new Set(['expired', 'settled', 'not_found']);
const PERMISSION_MODES = new Set(['build', 'edit', 'plan', 'yolo']);
const MIN_POLL_MS = 30 * 1000;
const MAX_POLL_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 60 * 1000;

/** The desktop's canned continuation prompt after a window expires mid-run. */
const CONTINUATION_PROMPT = 'Continue the previous task from where it left off. The run was interrupted (app restart or execution window expired). Do not start over; review what has already been done and complete the remaining work.';

class OffPeakApiError extends Error {
  constructor(message, { httpStatus = null, bizCode = null, nextTakeAt = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'OffPeakApiError';
    this.httpStatus = httpStatus;
    this.bizCode = bizCode === null ? null : Number(bizCode);
    this.nextTakeAt = nextTakeAt; // epoch ms or null
    this.retryAfterMs = retryAfterMs;
  }
  get kind() {
    if (this.bizCode === 3101 || this.httpStatus === 403) return 'eligibility';
    if (this.bizCode === 3103) return 'quota';
    if (this.bizCode === 3105 || this.httpStatus === 429) return 'rate_limited';
    if (this.bizCode === 3102 || this.bizCode === 3001) return 'ticket_expired';
    return 'api';
  }
  /** Human line for tool errors, including the next-allowed time when known. */
  describe() {
    let s = this.message;
    if (this.kind === 'eligibility') s += ' (idle-time tasks require a Z.ai Coding Plan subscription)';
    const wait = this.nextTakeAt || (this.retryAfterMs ? Date.now() + this.retryAfterMs : null);
    if ((this.kind === 'quota' || this.kind === 'rate_limited') && wait) {
      s += ` — you can create another task in ${fmtDuration(wait - Date.now())} (at ${new Date(wait).toISOString()})`;
    }
    return s;
  }
}

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function isoOrNull(epoch) { return epoch ? new Date(epoch).toISOString() : null; }

// ---------------------------------------------------------------- cloud client
class OffPeakCloudClient {
  /** opts: {origin, loadAuth, fetchImpl, logger, timeoutMs} */
  constructor(opts = {}) {
    this.origin = opts.origin || process.env.ZCODE_PLAN_ORIGIN || 'https://zcode.z.ai';
    this.loadAuth = opts.loadAuth || defaultLoadAuth;
    this.fetchImpl = opts.fetchImpl || ((u, i) => fetch(u, i));
    this.log = opts.logger || (() => {});
    this.timeoutMs = opts.timeoutMs || 20000;
  }

  async _request(method, apiPath, body) {
    const auth = await this.loadAuth();
    const res = await this.fetchImpl(`${this.origin}/api/v1/off-peak${apiPath}`, {
      method,
      headers: Object.assign(
        {
          authorization: `Bearer ${auth.jwt}`,
          'x-coding-plan-api-key': auth.codingPlanApiKey,
          'x-request-id': crypto.randomUUID(),
        },
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok) {
      const d = (parsed && parsed.data) || {};
      const nextRaw = parsed.next_take_at ?? d.next_take_at;
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      throw new OffPeakApiError(
        `off-peak ${apiPath} failed: HTTP ${res.status}${parsed.code !== undefined ? ` code=${parsed.code}` : ''}${parsed.msg || parsed.message ? ` ${parsed.msg || parsed.message}` : ''}`,
        {
          httpStatus: res.status,
          bizCode: parsed.code ?? null,
          nextTakeAt: nextRaw ? Number(nextRaw) * 1000 : null,
          retryAfterMs: retryAfter ? retryAfter * 1000 : null,
        },
      );
    }
    // success envelope: {code:0, msg, data}
    if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new OffPeakApiError(`off-peak ${apiPath}: business code ${parsed.code}${parsed.msg ? ` (${parsed.msg})` : ''}`,
        { bizCode: parsed.code, nextTakeAt: parsed.data && parsed.data.next_take_at ? Number(parsed.data.next_take_at) * 1000 : null });
    }
    return (parsed && parsed.data !== undefined ? parsed.data : parsed) || {};
  }

  /** -> {canTakeNumber, nextTakeAt(ms)|null} */
  async getAvailability() {
    const d = await this._request('GET', '/ticket/availability');
    if (d.can_take_number !== true && d.next_take_at === undefined) {
      throw new OffPeakApiError('off-peak availability response missing next_take_at while unavailable');
    }
    return {
      canTakeNumber: d.can_take_number === true,
      nextTakeAt: d.next_take_at !== undefined && d.next_take_at !== null ? Number(d.next_take_at) * 1000 : null,
    };
  }

  /** -> {ticketId, state, position|null, nextPollAfterMs|null} */
  async takeTicket(taskId) {
    const d = await this._request('POST', '/ticket', { task_id: taskId });
    if (!d.ticket_id) throw new OffPeakApiError('off-peak take ticket response missing ticket_id');
    return {
      ticketId: String(d.ticket_id),
      state: String(d.state || 'queued'),
      position: d.position !== undefined && d.position !== null ? Number(d.position) : null,
      nextPollAfterMs: d.next_poll_after !== undefined && d.next_poll_after !== null ? Number(d.next_poll_after) * 1000 : null,
    };
  }

  /** -> {nextPollAfterMs|null, tickets: [{ticketId, state, position, activeDeadline}]} */
  async batchStatus(ticketIds) {
    if (!ticketIds.length) return { nextPollAfterMs: null, tickets: [] };
    const d = await this._request('POST', '/ticket/status', { ticket_ids: ticketIds.slice(0, 100) });
    const tickets = (d.tickets || []).map((t) => ({
      ticketId: String(t.ticket_id),
      state: String(t.state || 'queued'),
      position: t.position !== undefined && t.position !== null ? Number(t.position) : null,
      activeDeadline: t.active_deadline !== undefined && t.active_deadline !== null ? Number(t.active_deadline) * 1000 : null,
    }));
    return {
      nextPollAfterMs: d.next_poll_after !== undefined && d.next_poll_after !== null ? Number(d.next_poll_after) * 1000 : null,
      tickets,
    };
  }

  async settle(ticketId) {
    await this._request('POST', `/ticket/${encodeURIComponent(ticketId)}/settle`);
    return { settled: true };
  }
}

function defaultLoadAuth() {
  // Same credentials the desktop's off-peak client uses: the zcode JWT plus
  // the coding-plan api key of the active plan.
  const jwt = harnessEnv.readZcodeJwt();
  if (!jwt) throw new Error('zcodejwttoken missing from harness credentials — sign in to ZCode once');
  const apiKey = harnessEnv.accountApiKey(harnessEnv.readDefaultModel().providerId);
  return { jwt, codingPlanApiKey: apiKey || '' };
}

// ---------------------------------------------------------------- manager
class OffPeakManager {
  /**
   * opts: { manager (AgentManager), dir (status dir, default out/offpeak),
   *         cloud (OffPeakCloudClient), logger, maxConcurrentRuns,
   *         turnTimeoutMs, pollIntervalMs }
   */
  constructor(opts = {}) {
    this.manager = opts.manager;
    this.cloud = opts.cloud || new OffPeakCloudClient({ logger: opts.logger });
    this.log = opts.logger || (() => {});
    this.dir = opts.dir ? path.resolve(opts.dir) : path.join(__dirname, '..', 'out', 'offpeak');
    this.store = new SessionStatusStore(this.dir, (m, x) => this.log(m, x || ''));
    this.maxConcurrentRuns = opts.maxConcurrentRuns || 2;
    this.turnTimeoutMs = opts.turnTimeoutMs || 60 * 60 * 1000; // idle runs may be long
    this.defaultPollMs = opts.pollIntervalMs || DEFAULT_POLL_MS;
    this._timer = null;
    this._syncing = false;
    this._stopped = true;
    this._running = new Set(); // offPeakTaskIds currently dispatching
  }

  // ------------------------------------------------------------- models
  /** Off-peak providers from the builtin registry (mode === "off-peak"). */
  idleProviders() {
    return harnessEnv.planCatalog().filter((p) => p.mode === 'off-peak');
  }

  /**
   * Allowed idle models. -> [{providerId, modelId, isDefault, providerName}]
   * Default = the LAST registry entry of the (zai) family — the desktop picks
   * "the newest allowed model".
   */
  allowedModels() {
    const provs = this.idleProviders();
    const zai = provs.filter((p) => p.family !== 'bigmodel');
    const family = zai.length ? zai : provs; // fall back to whatever exists
    const out = [];
    for (const p of family) {
      const models = p.models || [];
      models.forEach((modelId, i) => out.push({
        providerId: p.providerId,
        providerName: p.name,
        modelId,
        isDefault: family.length === 1 && i === models.length - 1,
      }));
    }
    return out;
  }

  /** Resolve a requested model id against the allowed list (default: newest). */
  resolveModel(model) {
    const allowed = this.allowedModels();
    if (!allowed.length) throw new OffPeakApiError('no idle-time (off-peak) providers in the harness registry');
    if (!model || !String(model).trim()) return allowed[allowed.length - 1];
    const wanted = String(model).trim().toLowerCase();
    const hit = allowed.find((m) => m.modelId.toLowerCase() === wanted)
      || allowed.find((m) => `${m.providerId}/${m.modelId}`.toLowerCase() === wanted);
    if (!hit) {
      throw new OffPeakApiError(`model "${model}" is not an idle-time allowed model; allowed: ${allowed.map((m) => m.modelId).join(', ')}`);
    }
    return hit;
  }

  async availability() { return this.cloud.getAvailability(); }

  // ------------------------------------------------------------ creation
  /**
   * Queue an idle-time task. opts: {title, prompt, workspace?, model?,
   * permissionMode?, thoughtLevel?, sessionId? (bind to a live bridge session),
   * skipAvailabilityCheck?}
   * Returns the task view. Throws OffPeakApiError with .describe() for
   * eligibility/quota/rate-limit problems (next-allowed time included).
   */
  async create(opts = {}) {
    const title = String(opts.title || '').trim();
    const prompt = String(opts.prompt || '').trim();
    if (!title) throw new Error('title is required');
    if (!prompt) throw new Error('prompt is required (state the deliverable — nobody answers questions during the run)');
    const permissionMode = opts.permissionMode || 'yolo';
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`invalid permissionMode "${permissionMode}" (build|edit|plan|yolo)`);
    const model = this.resolveModel(opts.model);

    if (!opts.skipAvailabilityCheck) {
      const av = await this.cloud.getAvailability(); // throws 3101/403 for ineligible accounts
      if (!av.canTakeNumber) {
        throw new OffPeakApiError('idle-time task quota: no ticket available right now', {
          bizCode: 3103, nextTakeAt: av.nextTakeAt,
        });
      }
    }

    const workspacePath = path.resolve(opts.workspace || (this.manager && this.manager.workspacePath) || process.cwd());
    let boundSessionId = null;
    if (opts.sessionId) {
      boundSessionId = String(opts.sessionId);
      const known = this.manager && this.manager.sessionInfo(boundSessionId);
      if (!known) throw new Error(`unknown session ${boundSessionId} (bind only live bridge sessions)`);
      if (this._docs().some((t) => (t.boundSessionId === boundSessionId || t.runSessionId === boundSessionId) && !TERMINAL_STATUSES.has(t.status))) {
        throw new OffPeakApiError('this session already has a pending idle-time task — wait for it to finish or cancel it first', { bizCode: 0 });
      }
    }

    const id = `offpeak-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
    let ticket = null;
    try {
      ticket = await this.cloud.takeTicket(id);
    } catch (e) {
      if (e instanceof OffPeakApiError) throw e;
      throw new OffPeakApiError(`failed to take an idle-time ticket: ${e.message}`, {});
    }

    const now = Date.now();
    const task = {
      id, title, prompt,
      status: 'queued',
      queuePosition: ticket.position,
      boundSessionId,
      runSessionId: null,
      modelSelection: { providerId: model.providerId, modelId: model.modelId },
      permissionMode,
      thoughtLevel: opts.thoughtLevel ? String(opts.thoughtLevel) : null,
      workspacePath,
      serverTicketId: ticket.ticketId,
      ticketState: ticket.state,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      attempts: 0,
      needsResume: false,
      nextPollAt: ticket.nextPollAfterMs ? now + clampPoll(ticket.nextPollAfterMs) : now + this.defaultPollMs,
      settled: false,
      pid: process.pid,
    };
    this._save(task, { event: { event: 'created', ticketId: ticket.ticketId, state: ticket.state, position: ticket.position } });
    this.start();
    if (ticket.state === 'ready') this._kick();
    return this._view(task);
  }

  // -------------------------------------------------------------- listing
  /** Local task docs (memory of this directory of truth). */
  _docs() { return this.store.list().filter((d) => d && d.id && d.id.startsWith('offpeak-')); }

  _byId(id) { return this._docs().find((d) => d.id === id) || null; }

  /**
   * List tasks, newest first. With refresh=true (default) polls the server for
   * live ticket state/queue position and rewrites changed status files —
   * this is the on-disk mirror refresh external watchers rely on.
   */
  async list({ refresh = true } = {}) {
    if (refresh) await this.refreshTickets().catch((e) => this.log('ticket refresh failed', { error: e.message }));
    const tasks = this._docs().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { dir: this.dir, tasks: tasks.map((t) => this._view(t)) };
  }

  async get(id) {
    const t = this._byId(String(id || ''));
    if (!t) throw new Error(`unknown idle-time task ${id}`);
    return this._view(t);
  }

  /** Poll the server for every non-terminal task's ticket and persist changes. */
  async refreshTickets() {
    const docs = this._docs().filter((d) => !TERMINAL_STATUSES.has(d.status) && d.serverTicketId);
    if (!docs.length) return { refreshed: 0 };
    const { tickets } = await this.cloud.batchStatus(docs.map((d) => d.serverTicketId));
    const byTicket = new Map(tickets.map((t) => [t.ticketId, t]));
    let changed = 0;
    for (const d of docs) {
      const t = byTicket.get(d.serverTicketId);
      if (!t) continue;
      const posChanged = t.position !== undefined && t.position !== null && t.position !== d.queuePosition;
      const stateChanged = t.state !== d.ticketState;
      if (!posChanged && !stateChanged) continue;
      d.queuePosition = t.position !== undefined && t.position !== null ? t.position : d.queuePosition;
      d.ticketState = t.state;
      d.updatedAt = Date.now();
      this._save(d, { force: true, event: { event: 'ticket-update', state: t.state, position: d.queuePosition } });
      changed += 1;
    }
    return { refreshed: changed };
  }

  // -------------------------------------------------------------- actions
  async cancel(id) {
    const t = this._byId(String(id || ''));
    if (!t) throw new Error(`unknown idle-time task ${id}`);
    if (TERMINAL_STATUSES.has(t.status)) return this._view(t);
    if (this._running.has(t.id)) await this._stopRun(t).catch(() => {});
    t.status = 'cancelled';
    t.finishedAt = Date.now();
    t.updatedAt = t.finishedAt;
    this._save(t, { force: true, event: { event: 'cancelled' } });
    this._settle(t).catch((e) => this.log('settle after cancel failed', { id: t.id, error: e.message }));
    return this._view(t);
  }

  /** Pause: the poller stops dispatching/syncing this task while paused. */
  async pause(id) {
    const t = this._byId(String(id || ''));
    if (!t) throw new Error(`unknown idle-time task ${id}`);
    if (TERMINAL_STATUSES.has(t.status)) throw new Error(`cannot pause a ${t.status} task`);
    t.status = 'paused';
    t.updatedAt = Date.now();
    this._save(t, { force: true, event: { event: 'paused' } });
    return this._view(t);
  }

  /** Continue: un-pause; check the ticket live and retake when it expired
   *  (mirrors the desktop: an expired ticket re-queues the task at the tail). */
  async continue(id) {
    const t = this._byId(String(id || ''));
    if (!t) throw new Error(`unknown idle-time task ${id}`);
    if (t.status !== 'paused') throw new Error(`task is ${t.status}, not paused`);
    t.status = 'queued';
    t.updatedAt = Date.now();
    let retaken = false;
    if (t.serverTicketId) {
      let alive = true; // assume alive when the status check fails (desktop behavior)
      try {
        const { tickets } = await this.cloud.batchStatus([t.serverTicketId]);
        const st = tickets.find((x) => x.ticketId === t.serverTicketId);
        if (st) {
          alive = !TICKET_TERMINAL.has(st.state);
          t.ticketState = st.state;
          if (st.position !== undefined && st.position !== null) t.queuePosition = st.position;
          t.updatedAt = Date.now();
        }
      } catch (e) {
        this.log('continue status check failed', { id: t.id, error: e.message });
      }
      if (!alive) {
        retaken = await this._retake(t).catch((e) => { this.log('retake failed', { id: t.id, error: e.message }); return false; });
      }
    }
    this._save(t, { force: true, event: { event: 'continued', retakenTicket: retaken } });
    this._kick();
    return this._view(t);
  }

  async delete(id) {
    const t = this._byId(String(id || ''));
    if (!t) throw new Error(`unknown idle-time task ${id}`);
    if (!TERMINAL_STATUSES.has(t.status)) await this.cancel(t.id);
    try { fs.unlinkSync(this.store.fileFor(t.id)); } catch { /* already gone */ }
    try { fs.unlinkSync(this.store.logFileFor(t.id)); } catch { /* already gone */ }
    return { deleted: true, id: t.id };
  }

  // -------------------------------------------------------------- polling
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._schedule(Math.max(1000, MIN_POLL_MS));
    // Answer the app-server's host-side offPeak/create|list requests so the
    // agent tools work inside bridge sessions.
    if (this.manager && this.manager.attachOffPeak) this.manager.attachOffPeak(this);
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._syncPass().catch((e) => this.log('sync pass failed', { error: e.message })); }, delayMs);
    this._timer.unref && this._timer.unref();
  }

  _kick() { this._syncPass().catch((e) => this.log('sync pass failed', { error: e.message })); }

  clampPoll(ms) { return clampPoll(ms === undefined || ms === null ? this.defaultPollMs : ms); }

  async _syncPass() {
    if (this._syncing || this._stopped) return;
    this._syncing = true;
    let nextDelay = this.defaultPollMs;
    try {
      const docs = this._docs().filter((d) => !TERMINAL_STATUSES.has(d.status));
      const syncable = docs.filter((d) => d.status !== 'paused' && d.serverTicketId);
      if (syncable.length) {
        const { nextPollAfterMs, tickets } = await this.cloud.batchStatus(syncable.map((d) => d.serverTicketId));
        if (nextPollAfterMs) nextDelay = this.clampPoll(nextPollAfterMs);
        const byTicket = new Map(tickets.map((t) => [t.ticketId, t]));
        for (const d of syncable) {
          if (this._running.has(d.id)) {
            // Running: watch for window expiry mid-run.
            const st = byTicket.get(d.serverTicketId);
            if (st && TICKET_TERMINAL.has(st.state)) await this._onExpiredDuringRun(d);
            continue;
          }
          const st = byTicket.get(d.serverTicketId);
          if (!st) continue;
          if (st.position !== undefined && st.position !== null && st.position !== d.queuePosition) {
            d.queuePosition = st.position;
          }
          if (st.state !== d.ticketState) d.ticketState = st.state;
          d.updatedAt = Date.now();
          if (st.state === 'expired' || st.state === 'not_found') {
            // Paused too long / dropped by the server: retake and requeue.
            this._save(d, { force: true, event: { event: 'ticket-update', state: st.state } });
            await this._retake(d).catch((e) => this.log('retake failed', { id: d.id, error: e.message }));
            continue;
          }
          if (st.state === 'ready' && this._running.size < this.maxConcurrentRuns) {
            this._save(d, { force: true, event: { event: 'ticket-ready' } });
            this._dispatch(d).catch((e) => this.log('dispatch failed', { id: d.id, error: e.message }));
          } else {
            this._save(d, { event: { event: 'ticket-update', state: st.state, position: d.queuePosition } });
          }
        }
      }
    } finally {
      this._syncing = false;
      this._schedule(nextDelay);
    }
  }

  /** Take a fresh ticket for an existing task (expired/continue path). */
  async _retake(task) {
    const t = await this.cloud.takeTicket(task.id);
    task.serverTicketId = t.ticketId;
    task.ticketState = t.state;
    task.queuePosition = t.position !== undefined && t.position !== null ? t.position : task.queuePosition;
    task.updatedAt = Date.now();
    task.nextPollAt = Date.now() + (t.nextPollAfterMs ? this.clampPoll(t.nextPollAfterMs) : this.defaultPollMs);
    this._save(task, { force: true, event: { event: 'ticket-retaken', ticketId: t.ticketId, state: t.state } });
    if (t.state === 'ready' && this._running.size < this.maxConcurrentRuns) {
      this._dispatch(task).catch((e) => this.log('dispatch after retake failed', { id: task.id, error: e.message }));
    }
    return true;
  }

  async _onExpiredDuringRun(task) {
    task.ticketState = 'expired';
    task.needsResume = true;
    task.updatedAt = Date.now();
    this._save(task, { force: true, event: { event: 'ticket-expired-during-run' } });
    await this._stopRun(task).catch(() => {});
    // Requeue at the tail, exactly like the desktop's continuation flow.
    task.status = 'queued';
    task.updatedAt = Date.now();
    this._save(task, { force: true, event: { event: 'requeued', reason: 'ticket-expired' } });
    await this._retake(task).catch((e) => this.log('retake after expiry failed', { id: task.id, error: e.message }));
  }

  async _stopRun(task) {
    if (this.manager && task.runSessionId) {
      await this.manager.stopSession(task.runSessionId).catch(() => {});
    }
  }

  // ------------------------------------------------------------- dispatch
  /** Run a ready task. Fire-and-forget safe; state lands on disk. */
  async _dispatch(task) {
    if (this._running.has(task.id) || TERMINAL_STATUSES.has(task.status)) return;
    this._running.add(task.id);
    task.status = 'running';
    task.startedAt = Date.now();
    task.updatedAt = task.startedAt;
    task.attempts += 1;
    this._save(task, { force: true, event: { event: 'dispatch-started', attempt: task.attempts } });
    try {
      await this._runTask(task);
      task.status = 'completed';
      task.finishedAt = Date.now();
      task.lastError = null;
      this._save(task, { force: true, event: { event: 'turn-completed' } });
    } catch (e) {
      const expired = e instanceof OffPeakApiError && e.kind === 'ticket_expired';
      if (expired) {
        await this._onExpiredDuringRun(task).catch(() => {});
      } else {
        task.status = 'failed';
        task.finishedAt = Date.now();
        task.lastError = String(e.message || e);
        this._save(task, { force: true, event: { event: 'turn-failed', error: task.lastError } });
      }
    } finally {
      this._running.delete(task.id);
      if (TERMINAL_STATUSES.has(task.status)) {
        this._settle(task).catch((e) => this.log('settle failed', { id: task.id, error: e.message }));
      }
    }
  }

  async _settle(task) {
    if (!task.serverTicketId || task.settled) return;
    try {
      await this.cloud.settle(task.serverTicketId);
      task.settled = true;
      task.ticketState = 'settled';
      task.updatedAt = Date.now();
      this._save(task, { force: true, event: { event: 'settled' } });
    } catch (e) {
      if (e instanceof OffPeakApiError && e.httpStatus !== null && e.httpStatus < 500) {
        task.settled = true; // 4xx = server already considers it terminal
        task.ticketState = 'settled';
        task.updatedAt = Date.now();
        this._save(task, { force: true, event: { event: 'settled', note: `accepted ${e.httpStatus}` } });
      } else {
        this.log('settle retry later', { id: task.id, error: e.message });
      }
    }
  }

  /**
   * The actual agent run. Overridable for tests. Runs the task prompt as a
   * bridge session turn with the off-peak provider, ticket-scoped request
   * auth (the free-compute header set), and the desktop's send params.
   */
  async _runTask(task) {
    const mgr = this.manager;
    if (!mgr) throw new Error('no AgentManager attached to the off-peak manager');
    const client = await mgr.ensureClient();

    // Entitle the off-peak provider in the app-server registry so its models
    // are selectable (same push the bridge uses for plan providers).
    const workspace = { workspacePath: task.workspacePath, workspaceKey: task.workspacePath };
    const act = await mgr._activateAccount(client, task.modelSelection.providerId, workspace);
    if (!act) throw new Error(`could not entitle off-peak provider ${task.modelSelection.providerId} in the harness registry`);

    // Bound session still alive? Then this is a bound first run: continue
    // that conversation (full history available). Otherwise fresh session.
    const boundAlive = task.boundSessionId && mgr.sessionInfo(task.boundSessionId);
    const kind = task.needsResume ? 'resume' : 'init';
    let sessionId = boundAlive || task.runSessionId || null;
    if (!sessionId) {
      const created = await mgr.createSession({
        workspacePath: task.workspacePath,
        mode: task.permissionMode,
        model: Object.assign({}, task.modelSelection, {
          options: { reasoningLevel: task.thoughtLevel || 'high' },
        }),
      });
      sessionId = created.sessionId;
    }
    task.runSessionId = sessionId;
    task.updatedAt = Date.now();
    this._save(task, { force: true, event: { event: 'run-session', sessionId, kind } });

    const prompt = task.needsResume ? CONTINUATION_PROMPT : task.prompt;
    const creds = await this._ticketAuth(task);
    await mgr.runTurn(sessionId, prompt, {
      timeoutMs: this.turnTimeoutMs,
      extraSendParams: {
        offPeakTaskId: task.id,
        offPeakRunType: kind,
        modelSelection: {
          providerId: task.modelSelection.providerId,
          modelId: task.modelSelection.modelId,
          options: { reasoningLevel: task.thoughtLevel || 'high' },
        },
        // mirrors the desktop host's off-peak run params exactly; the harness
        // schema REQUIRES selectionScope:"execution" (without it every idle run
        // failed: "modelExecution.selectionScope: expected \"execution\"").
        modelExecution: {
          memoryExtraction: 'skip',
          selectionScope: 'execution',
          requestAuth: creds,
          subagents: { foregroundModel: 'submission', background: 'deny' },
        },
        toolDenylist: ['CronCreate', 'OffPeakCreate'],
      },
    });
    task.needsResume = false;
  }

  /** Ticket-scoped model request auth — the headers that bill off-peak. */
  async _ticketAuth(task) {
    const auth = await this.cloud.loadAuth();
    return {
      apiKey: auth.jwt,
      headers: Object.assign(
        {
          Authorization: `Bearer ${auth.jwt}`,
          'X-Off-Peak-Ticket-ID': task.serverTicketId,
        },
        auth.codingPlanApiKey ? { 'X-Coding-Plan-Api-Key': auth.codingPlanApiKey } : {},
      ),
    };
  }

  // -------------------------------------------------- host-request handler
  /**
   * Server->client "offPeak/create" / "offPeak/list" from the app-server
   * (the agent tools). Response shapes mirror the desktop host exactly.
   */
  async handleHostRequest(method, params) {
    if (method === 'offPeak/list') {
      const { tasks } = await this.list({ refresh: false });
      return { tasks: tasks.slice(0, 20) };
    }
    if (method === 'offPeak/create') {
      const p = params || {};
      try {
        const task = await this.create({
          title: p.title,
          prompt: p.prompt,
          permissionMode: p.permissionMode,
          model: p.model,
          thoughtLevel: p.thoughtLevel,
          sessionId: p.boundSessionId,
        });
        return { ok: true, task };
      } catch (e) {
        if (e instanceof OffPeakApiError) {
          return {
            ok: false,
            failureStage: e.kind === 'eligibility' || e.kind === 'quota' || e.kind === 'rate_limited' ? 'ticket_request' : 'client_validation',
            errorCategory: e.kind === 'eligibility' ? 'eligibility_3101' : e.kind === 'quota' ? 'quota_3103' : e.kind === 'rate_limited' ? 'network' : 'client_validation',
            errorCode: String(e.bizCode === null ? '' : e.bizCode),
            message: e.describe(),
          };
        }
        return { ok: false, failureStage: 'client_validation', errorCategory: 'client_validation', errorCode: '', message: String(e.message || e) };
      }
    }
    throw new Error(`unsupported offPeak host method ${method}`);
  }

  // ---------------------------------------------------------------- disk
  _save(task, { force = false, event = null } = {}) {
    this.store.record(task.id, task, { force: force || !!event, event });
  }

  /** Client-facing view (desktop OffPeakTaskSummary shape + bridge extras). */
  _view(task) {
    const sessionId = task.runSessionId || task.boundSessionId || null;
    const view = {
      offPeakTaskId: task.id,
      title: task.title,
      status: task.status,
      ...(task.queuePosition !== undefined && task.queuePosition !== null ? { queuePosition: task.queuePosition } : {}),
      ...(sessionId ? { sessionId } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      // bridge extras
      model: task.modelSelection,
      permissionMode: task.permissionMode,
      workspace: task.workspacePath,
      ticketState: task.ticketState,
      attempts: task.attempts,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.lastError ? { lastError: task.lastError } : {}),
    };
    if (sessionId && this.manager && this.manager.status) {
      view.sessionStatusFile = this.manager.status.fileFor(sessionId);
    }
    return view;
  }
}

function clampPoll(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, ms));
}

module.exports = {
  OffPeakManager,
  OffPeakCloudClient,
  OffPeakApiError,
  CONTINUATION_PROMPT,
  TERMINAL_STATUSES,
  fmtDuration,
};
