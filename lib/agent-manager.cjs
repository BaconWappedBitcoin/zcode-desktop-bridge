'use strict';
/**
 * agent-manager.cjs — session lifecycle and turn execution over the
 * ZCode Protocol app-server.
 *
 * Responsibilities:
 *  - own one app-server connection and its one-time account bootstrap
 *  - create sessions (yolo mode by default) with model + reasoning level
 *  - optionally import prior conversation history (claudeCode format) at create
 *  - run a turn end-to-end: send -> stream text via session/messages polling
 *    -> resolve final text/reasoning/usage when the turn terminates
 *  - stop/close, idle-session reaping, restart on app-server death
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ZCodeProtocolClient, ProtocolError } = require('./zcode-protocol.cjs');
const { SessionStatusStore, TAIL_MAX } = require('./session-status.cjs');
const harnessEnv = require('./harness-env.cjs');
const planRouter = require('./plan-router.cjs');
const v4 = require('./v4-commands.cjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ------------------------------------------------------------- live stream text
const clockOf = (ms) => new Date(ms).toTimeString().slice(0, 8);
const oneLine = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const modelLabel = (m) => (m && m.modelId ? `${m.modelId}${m.options && m.options.reasoningLevel ? ` (${m.options.reasoningLevel})` : ''}` : '?');
/** What a tool step is about, in one line: its own description, else its command, path or pattern. */
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

class TurnAborted extends Error {
  constructor(reason) { super(reason || 'turn aborted'); this.name = 'TurnAborted'; }
}

/** The turn was cancelled through cancelTurn()/session/stop (not a failure). */
class TurnCancelled extends Error {
  constructor(reason) { super(reason || 'turn cancelled'); this.name = 'TurnCancelled'; }
}

class AgentManager extends Object {
  constructor(cfg = {}, logger = () => {}) {
    super();
    this.cfg = cfg;
    this.log = logger;
    const { exe, bundle } = harnessEnv.locateHarness(cfg);
    this.exe = exe;
    this.bundle = bundle;
    this.workspacePath = path.resolve(cfg.workspacePath || path.join(process.cwd(), 'bridge-workspace'));
    fs.mkdirSync(this.workspacePath, { recursive: true });
    this.defaultModel = cfg.model || harnessEnv.readDefaultModel();
    // the bridge process this manager runs in, as lib/bridge-registry.cjs knows it: stamped on every
    // status document so another process can find this session's owner
    this.ownerId = cfg.ownerId || null;
    this.mode = cfg.mode || 'yolo';
    this.turnTimeoutMs = cfg.turnTimeoutMs || 15 * 60 * 1000;
    // async turns detach instead of erroring when this cap passes (see
    // _awaitTurnEnd): the harness keeps running, the bridge keeps following
    this.asyncTurnTimeoutMs = cfg.asyncTurnTimeoutMs || 6 * 60 * 60 * 1000;
    this.client = null;
    this.accountBootstrapped = false;
    this.sessions = new Map(); // sessionId -> record (see createSession)
    this.statusDir = cfg.statusDir ? path.resolve(cfg.statusDir) : path.join(__dirname, '..', 'out', 'sessions');
    this.status = new SessionStatusStore(this.statusDir, (m, x) => this.log(m, x || ''));
    this._turnSeq = 0;
    this._notificationHandlers = new Set();
    this._starting = null;
    // V4 conversation state per session (revision, phase, input queue), from v4/conversation/frame
    this.v4 = new Map();
    this.v4Frames = v4.createFrameAssembler();
    // how each ZCode turn ended (turn.completed / turn.failed session events), by ZCode's turnId: a turn the
    // bridge follows can end within the same notification burst that started it
    this.turnEnds = new Map();
    this.v4ClientId = `zcode-bridge-${this.ownerId || process.pid}`;
    this.onNotification((msg) => this._onV4Notification(msg));
  }

  onNotification(fn) { this._notificationHandlers.add(fn); return () => this._notificationHandlers.delete(fn); }

  /**
   * Attach the bridge's idle-time (off-peak) task service: the app-server's
   * server->client offPeak/create|list requests (the agent tools) get
   * answered by it, on this client and every future one after a restart.
   * Also flips the app-server's off-peak tool policy on for this workspace so
   * bridge sessions expose OffPeakCreate/OffPeakList to their agents.
   */
  attachOffPeak(offPeakManager) {
    this._offPeak = offPeakManager;
    const handler = (method, params) => offPeakManager.handleHostRequest(method, params);
    const wire = (client) => {
      if (!client) return;
      client.offPeakHandler = handler;
      client.call('workspace/updateOffPeakToolPolicy', {
        workspace: { workspacePath: this.workspacePath, workspaceKey: this.workspacePath },
        enabled: true,
      }, 15000).then(
        () => this.log('off-peak agent tool enabled for workspace', { workspace: this.workspacePath }),
        (e) => this.log('workspace/updateOffPeakToolPolicy failed (agent OffPeakCreate tool stays off)', { error: e.message }),
      );
    };
    if (this.client && this.client.running) wire(this.client);
    this._wireOffPeak = wire;
  }

  async ensureClient() {
    if (this.client && this.client.running) return this.client;
    if (this._starting) return this._starting;
    this._starting = this._startClient().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _startClient() {
    const client = new ZCodeProtocolClient({
      exe: this.exe,
      bundle: this.bundle,
      surface: this.cfg.surface || 'desktop',
      workspacePath: this.workspacePath,
      logger: this.log,
      permissionPolicy: this.cfg.permissionPolicy,
      runtimePrefs: this.cfg.runtimePrefs,
      // ZCode's session mailbox (lib/zcode-mailbox.cjs): the bridge's sessions take messages left for them
      env: this.cfg.sessionMailbox === false ? {} : { ZCODE_MESSAGE_ENABLED: '1' },
    });
    client.on('notification', (msg) => {
      for (const h of this._notificationHandlers) {
        try { h(msg); } catch { /* handler errors must not break the pump */ }
      }
    });
    client.on('exit', (err) => {
      if (this.client === client) {
        this.client = null;
        this.accountBootstrapped = false;
        this.log('app-server died', { error: err.message });
      }
    });
    await client.start();
    this.client = client;
    if (this._wireOffPeak) this._wireOffPeak(client);
    return client;
  }

  /**
   * Resolve a user-facing model reference against the live model list.
   * Accepts "GLM-5.3-Flash", "account:zai-individual-coding-plan/GLM-5.3-Flash",
   * or {providerId, modelId, reasoningLevel?}. Returns a full selection
   * {providerId, modelId, options:{reasoningLevel}} or throws with the
   * available options listed.
   */
  async resolveModelSelection(ref, { reasoningLevel } = {}) {
    // "auto:<modelId>" -> the plan that currently has credit (lib/plan-router.cjs)
    if (typeof ref === 'string' && ref.trim().toLowerCase().startsWith('auto:')) {
      const want = ref.trim().slice(5);
      const routed = await planRouter.route(want, { policy: this.cfg.planRouter });
      if (!routed.providerId) throw new Error(routed.reason);
      this.log('plan-router', { model: want, providerId: routed.providerId, reason: routed.reason });
      if (!this.accountBootstrapped) {
        try { await this.setPlan(routed.providerId, { modelId: routed.modelId }); } catch (e) { this.log('plan-router activation failed', { error: e.message }); }
      }
      ref = `${routed.providerId}/${routed.modelId}`;
    }
    const models = await this.listModels();
    const wanted = typeof ref === 'string' ? ref.trim() : ref;
    let entry = null;
    if (typeof wanted === 'string') {
      const lower = wanted.toLowerCase();
      const slashAt = lower.indexOf('/');
      entry = models.find((m) => m.ref && `${m.ref.providerId}/${m.ref.modelId}`.toLowerCase() === lower)
        || (slashAt !== -1
          ? models.find((m) => m.ref && m.ref.providerId.toLowerCase() === lower.slice(0, slashAt) && m.ref.modelId.toLowerCase() === lower.slice(slashAt + 1))
          : models.find((m) => m.ref && String(m.ref.modelId).toLowerCase() === lower));
    } else if (wanted && wanted.providerId) {
      entry = models.find((m) => m.ref && m.ref.providerId === wanted.providerId && m.ref.modelId === wanted.modelId)
        || models.find((m) => m.ref && m.ref.modelId === wanted.modelId);
    }
    if (!entry || !entry.ref) {
      const list = models.map((m) => (m.ref ? `${m.ref.providerId}/${m.ref.modelId}` : '?')).join(', ');
      throw new Error(`model not found: ${typeof wanted === 'string' ? wanted : JSON.stringify(wanted)}. Available: ${list}`);
    }
    const levels = (entry.reasoning && entry.reasoning.levels || []).map((l) => l.value);
    let level = reasoningLevel
      || (typeof wanted === 'object' && wanted.reasoningLevel)
      || (entry.reasoning && entry.reasoning.defaultLevel)
      || levels[0]
      || 'high';
    if (levels.length && !levels.includes(level)) {
      throw new Error(`reasoning level "${level}" not supported for ${entry.ref.modelId}; supported: ${levels.join(', ')}`);
    }
    return { providerId: entry.ref.providerId, modelId: entry.ref.modelId, options: levels.length ? { reasoningLevel: level } : {}, entry };
  }

  /** Change the bridge's default model for future sessions. */
  async setDefaultModel(ref, opts = {}) {
    const sel = await this.resolveModelSelection(ref, opts);
    this.defaultModel = { providerId: sel.providerId, modelId: sel.modelId, options: sel.options };
    this.log('default model switched', this.defaultModel);
    return this.defaultModel;
  }

  /** Live-switch the model of an existing session (fails if a turn is running). */
  async setSessionModel(sessionId, ref, opts = {}) {
    const client = await this.ensureClient();
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId}`);
    const sel = await this.resolveModelSelection(ref, opts);
    await client.call('session/setModel', { sessionId, model: { providerId: sel.providerId, modelId: sel.modelId, options: sel.options } }, 30000);
    rec.model = { providerId: sel.providerId, modelId: sel.modelId, options: sel.options };
    rec.lastUsedAt = Date.now();
    rec.lastActivity = Date.now();
    this._persistStatus(sessionId, { force: true, event: { event: 'model-changed', model: rec.model } });
    return rec.model;
  }

  // ---------------------------------------------------------------- create
  async createSession(opts = {}) {
    const client = await this.ensureClient();
    const workspacePath = opts.workspacePath ? path.resolve(opts.workspacePath) : this.workspacePath;
    fs.mkdirSync(workspacePath, { recursive: true });
    const workspace = { workspacePath, workspaceKey: workspacePath };

    if (!this.accountBootstrapped) {
      this.accountBootstrapped = true; // set optimistically; one activation pass per process
      await this._activateAccount(client, (opts.model || this.defaultModel).providerId, workspace);
    }

    const created = await client.call('session/create', {
      workspace,
      mode: opts.mode || this.mode,
      titleGenerationEnabled: false,
      ...(opts.importedHistory ? { importedHistory: opts.importedHistory } : {}),
    }, 90000);
    const sessionId = created && created.session && created.session.sessionId;
    if (!sessionId) throw new Error('session/create returned no sessionId');
    const models = this._modelsFrom(created);

    // Model selection: explicit > configured default > first available.
    const wanted = opts.model || this.defaultModel;
    const entry = models.find((m) => m.ref && m.ref.providerId === wanted.providerId && m.ref.modelId === wanted.modelId)
      || models.find((m) => m.ref && m.ref.providerId === wanted.providerId)
      || ((opts.anyModel || !wanted.providerId) ? models[0] : null);
    if (!entry) {
      // Never fall back to another provider for a session that will run turns: a missing
      // account plan (failed activation) would otherwise silently run on whatever other
      // provider is listed first. listModels() passes anyModel (it only reads the catalog).
      await this.closeSession(sessionId).catch(() => {});
      const list = models.map((m) => (m.ref ? `${m.ref.providerId}/${m.ref.modelId}` : '?')).join(', ') || 'none';
      throw new Error(models.length
        ? `provider ${wanted.providerId} is not available in the harness registry (account activation failed?). Available: ${list}`
        : 'no models available in the harness registry (account bootstrap failed?)');
    }
    let modelSelection = { providerId: entry.ref.providerId, modelId: entry.ref.modelId };
    const level = (opts.reasoningLevel)
      || (wanted.options && wanted.options.reasoningLevel)
      || (entry.reasoning && entry.reasoning.defaultLevel)
      || 'high';
    modelSelection = Object.assign({}, modelSelection, { options: { reasoningLevel: level } });
    try {
      await client.call('session/setModel', { sessionId, model: modelSelection }, 30000);
    } catch (e) {
      await this.closeSession(sessionId).catch(() => {});
      throw new Error(`failed to set model ${modelSelection.providerId}/${modelSelection.modelId} (${level}): ${e.message}`);
    }
    try {
      await client.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, 15000);
    } catch (e) { this.log('subscribe failed (continuing)', { error: e.message }); }
    await this._v4Subscribe(client, sessionId, workspace);

    // The session record — and its on-disk status document — exist BEFORE the
    // first turn can start, so a client that loses track of the sessionId can
    // always recover it (zcode_sessions_list / statusDir files).
    const now = Date.now();
    this.sessions.set(sessionId, {
      createdAt: now, lastUsedAt: now, turns: 0, busy: false,
      workspacePath, model: modelSelection,
      status: 'idle', turnId: null, startedAt: null, finishedAt: null,
      lastActivity: now, lastOutputTail: '', finalTextTail: '',
      error: null, usage: null, current: null,
      cancelRequested: false, cancelledAt: 0,
      pid: process.pid,
    });
    this._persistStatus(sessionId, { force: true, event: { event: 'session-created', workspace: workspacePath } });
    return { sessionId, model: modelSelection, models };
  }

  /**
   * Activate account provider(s) in the worker registry: push entitlement for
   * every plan this machine holds credentials for (plus `primaryPid`), then
   * verify with a throwaway session created AFTER the push — a session's
   * model list is frozen at creation, so reading an older session never
   * reflects the push. Returns the verified model list, or null on failure.
   */
  async _activateAccount(client, primaryPid, workspace) {
    const planPids = harnessEnv.listPlanCredentials().map((p) => p.providerId)
      .filter((p) => String(p).startsWith('account:'));
    // With a personal default (an API-key provider such as DeepSeek) the plans this
    // machine holds credentials for still get entitled, so per-call overrides like
    // model "GLM-5.3" resolve; verification then uses the first credentialed plan.
    if (!String(primaryPid || '').startsWith('account:')) primaryPid = planPids[0];
    if (!primaryPid) return null;
    const credPids = [...new Set([primaryPid, ...planPids])];

    const cacheFile = path.join(__dirname, '..', 'out', '.builtin-revision.json');
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).basedOn; } catch { /* none */ }
    const candidates = [];
    const seen = new Set();
    for (const c of [cached, ...harnessEnv.builtinRevisionCandidates({ bundle: this.bundle })]) {
      if (c && !seen.has(c)) { seen.add(c); candidates.push(c); }
    }

    for (const basedOn of candidates) {
      try {
        await client.pushAccountConfig(credPids, basedOn);
      } catch (e) {
        this.log('account push failed', { basedOn, error: e.message });
        continue;
      }
      try {
        const t = await client.call('session/create', {
          workspace, mode: this.mode, titleGenerationEnabled: false,
        }, 90000);
        const sid = t && t.session && t.session.sessionId;
        const models = this._modelsFrom(t);
        const ok = models.some((m) => m.ref && m.ref.providerId === primaryPid);
        if (sid) await client.call('session/close', { sessionId: sid }, 15000).catch(() => {});
        if (ok) {
          this.log('account providers activated', { basedOn, providers: credPids });
          try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ basedOn })); } catch { /* cache is best-effort */ }
          return { models };
        }
      } catch (e) {
        this.log('activation verification failed', { basedOn, error: e.message });
      }
    }
    this.log('account activation: no candidate revision produced a model list');
    return null;
  }

  /**
   * Switch the bridge to another plan this machine holds credentials for.
   * Entitles the plan in the registry, validates its model list, and sets the
   * default model to `modelId` (or the plan's first/current model).
   */
  async setPlan(providerId, opts = {}) {
    const pid = String(providerId || '').trim();
    const cred = harnessEnv.listPlanCredentials().find((p) => p.providerId === pid);
    if (!cred) {
      const have = harnessEnv.listPlanCredentials().map((p) => p.providerId).join(', ') || '(none)';
      throw new Error(`no local credentials for plan ${pid}. Plans with credentials on this machine: ${have}`);
    }
    const client = await this.ensureClient();
    const workspace = { workspacePath: this.workspacePath, workspaceKey: this.workspacePath };
    const act = await this._activateAccount(client, pid, workspace);
    if (!act) throw new Error(`could not activate plan ${pid} in the harness registry (account push rejected)`);
    const models = act.models.filter((m) => m.ref && m.ref.providerId === pid);
    if (!models.length) throw new Error(`plan ${pid} exposes no models`);
    let entry = opts.modelId ? models.find((m) => m.ref.modelId === opts.modelId) : null;
    if (opts.modelId && !entry) {
      throw new Error(`model ${opts.modelId} is not offered by plan ${pid}; available: ${models.map((m) => m.ref.modelId).join(', ')}`);
    }
    if (!entry) entry = models.find((m) => m.ref.modelId === this.defaultModel.modelId) || models[0];
    const levels = (entry.reasoning && entry.reasoning.levels || []).map((l) => l.value);
    let level = opts.reasoningLevel || (entry.reasoning && entry.reasoning.defaultLevel) || levels[0] || 'high';
    if (levels.length && !levels.includes(level)) {
      throw new Error(`reasoning level "${level}" not supported for ${entry.ref.modelId}; supported: ${levels.join(', ')}`);
    }
    this.defaultModel = { providerId: pid, modelId: entry.ref.modelId, options: levels.length ? { reasoningLevel: level } : {} };
    this._modelsCache = act.models;
    this._modelsCacheAt = Date.now();
    this.accountBootstrapped = true;
    this.log('plan switched', this.defaultModel);
    return this.defaultModel;
  }

  _modelsFrom(snap) {
    try {
      const avail = snap.settings && snap.settings.model && snap.settings.model.available;
      return Array.isArray(avail) ? avail : [];
    } catch { return []; }
  }

  async listModels() {
    if (this._modelsCache && Date.now() - this._modelsCacheAt < 10 * 60 * 1000) return this._modelsCache;
    // The create snapshot lists the full model catalog; session/read filters
    // to fewer — always source the list from a fresh create.
    const created = await this.createSession({ anyModel: true });
    try {
      this._modelsCache = created.models || [];
      this._modelsCacheAt = Date.now();
      return this._modelsCache;
    } finally {
      await this.closeSession(created.sessionId).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ turn
  /**
   * Run one agent turn. opts:
   *   onDelta({type:'text'|'reasoning', text})  — incremental output
   *   onToolActivity(info)                       — tool lifecycle notices
   *   signal                                     — AbortSignal
   *   turnId                                     — pre-assigned id (startTurn)
   *   _reserved                                  — internal: busy already set
   * Resolves {sessionId, messageId, text, reasoning, usage, finishReason}.
   * Every rejection carries the sessionId in its message; turn state is
   * mirrored to the on-disk status document throughout.
   */
  async runTurn(sessionId, text, opts = {}) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    if (!opts._reserved && rec.busy) {
      throw new ProtocolError(`a prompt is already running for session ${sessionId} (turnId ${rec.turnId || '?'})`, { code: -32010 });
    }
    const turnId = opts.turnId || this._nextTurnId();
    // follow: a turn ZCode started on its own (a queued message draining, an interrupt) — watched, not sent
    const follow = opts.follow || null;
    const startedAt = follow ? Math.floor(follow.startedAt || Date.now()) : Date.now();
    rec.busy = true;
    rec.pendingFollow = null;
    // ZCode's own id for this turn: known now for a followed turn, from its turn.started event otherwise
    rec.cliTurnId = follow ? follow.cliTurnId || null : null;
    rec.turns += 1;
    rec.turnId = turnId;
    rec.status = 'running';
    rec.startedAt = startedAt;
    rec.finishedAt = null;
    rec.lastUsedAt = startedAt;
    rec.lastActivity = startedAt;
    rec.lastOutputTail = '';
    rec.finalTextTail = '';
    rec.error = null;
    rec.usage = null;
    rec.cancelRequested = false;
    rec.detached = false;
    rec.waitDeadlineHitAt = null;
    rec.streamPart = null;
    rec.streamAtLineStart = true;
    const origin = follow ? ` · ${follow.origin || 'from the queue'}` : '';
    this._streamWrite(sessionId, `\n── turn ${turnId} started ${clockOf(startedAt)} · ${modelLabel(rec.model)}${origin} ──\n» ${oneLine(text, 300)}\n`);
    this._persistStatus(sessionId, { force: true, event: { event: 'turn-started', turnId, ...(follow ? { origin: follow.origin || 'queue', inputId: follow.inputId } : {}) } });

    const userDelta = opts.onDelta;
    const turnOpts = Object.assign({}, opts, {
      // output of a turn that starts after this one (a queued message draining) is not this turn's
      endBefore: () => (rec.pendingFollow ? rec.pendingFollow.startedAt : Infinity),
      onDelta: (d) => {
        if (d && d.type === 'text') this._appendOutput(sessionId, d.text, d.key);
        if (userDelta) userDelta(d);
      },
      onTool: (t) => this._streamTool(sessionId, t),
    });

    const offNotification = this.onNotification((msg) => this._watchTurn(msg, sessionId, turnOpts));
    let result;
    try {
      const client = await this.ensureClient();
      if (!follow) {
        const sendR = await client.call('session/send', Object.assign(
          { sessionId, content: text },
          opts.extraSendParams || {},
        ), 60000);
        if (!sendR || !sendR.accepted) throw new Error(`session/send was not accepted for session ${sessionId}`);
      }
      result = await this._awaitTurnEnd(client, sessionId, startedAt, turnOpts);
      this._finishTurn(sessionId, turnId, rec.cancelRequested ? 'cancelled' : 'done', result);
    } catch (e) {
      const kind = (e instanceof TurnAborted || e instanceof TurnCancelled || rec.cancelRequested) ? 'cancelled' : 'error';
      this._finishTurn(sessionId, turnId, kind, null, e);
      throw e;
    } finally {
      offNotification();
      if (this.sessions.has(sessionId)) {
        this.sessions.get(sessionId).busy = false;
        this._afterTurn(sessionId);
      }
    }
    return result;
  }

  // ------------------------------------------------------------ V4: steer, queue, follow
  /** Subscribe to a session's V4 conversation topic: its frames keep this.v4 (revision, phase, queue) current. */
  async _v4Subscribe(client, sessionId, workspace) {
    const state = this.v4.get(sessionId) || v4.newState();
    this.v4.set(sessionId, state);
    try {
      const r = await client.call('v4/conversation/subscribe', {
        topic: `conversation/${sessionId}`,
        connectionId: this.v4ClientId,
        clientMode: 'desktop-continuous',
        ...(workspace ? { workspace } : {}),
      }, 30000);
      state.subscriptionId = r && r.ack && r.ack.subscriptionId;
    } catch (e) {
      this.log('v4 conversation subscribe failed (steering and the queue view are off for this session)', { sessionId, error: e.message });
    }
  }

  _onV4Notification(msg) {
    if (!msg || typeof msg.method !== 'string') return;
    const p = msg.params || {};
    if (msg.method === 'v4/conversation/frame') {
      const sid = v4.sessionOfTopic(p.topic);
      const state = sid && this.v4.get(sid);
      if (!state) return;
      const frame = this.v4Frames.accept(p);
      if (!frame) return;
      const changed = v4.applyFrame(state, frame);
      if (changed.queue && this.sessions.has(sid)) this._persistStatus(sid, { force: true, event: { event: 'queue', items: state.queue.items.length, autoDrain: state.queue.autoDrain } });
      return;
    }
    if (msg.method !== 'session/event' || !p.sessionId || !this.sessions.has(p.sessionId)) return;
    const payload = p.payload || {};
    if ((p.type === 'turn.completed' || p.type === 'turn.failed') && p.turnId) {
      this.turnEnds.set(p.turnId, { type: p.type, payload, at: Date.now() });
      if (this.turnEnds.size > 500) this.turnEnds.delete(this.turnEnds.keys().next().value);
      return;
    }
    if (p.type === 'turn.started' && !payload.inputId) {
      // the bridge's own session/send turn: note ZCode's id for it
      const rec = this.sessions.get(p.sessionId);
      if (rec.busy && !rec.cliTurnId) rec.cliTurnId = p.turnId || null;
      return;
    }
    if (p.type === 'turn.steerQueued') {
      const label = payload.delivery === 'guide' ? 'steer waiting for the next tool step' : 'queued for the next turn';
      this._streamNote(p.sessionId, `  ⇢ ${label}: ${oneLine(payload.input || payload.inputPreview, 240)}`);
    } else if (p.type === 'turn.steerDrained') {
      for (const d of payload.drainedInputs || []) this._streamNote(p.sessionId, `  » steer delivered: ${oneLine(d.text, 240)}`);
    } else if (p.type === 'turn.started' && payload.inputId) {
      // a turn from a V4 input: a queued message draining, or an interrupt — the bridge's own sends are
      // legacy session/send turns, which carry no inputId
      const rec = this.sessions.get(p.sessionId);
      const follow = { text: payload.input || '', startedAt: payload.executionStartedAt || Date.now(), inputId: payload.inputId, cliTurnId: p.turnId || null, origin: 'from the queue' };
      if (rec.busy) rec.pendingFollow = follow;
      else this._followTurn(p.sessionId, follow);
    }
  }

  /** A line in the session's live stream (and output tail) that is not model output: steer/queue events. */
  _streamNote(sessionId, line) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    const text = `${rec.streamAtLineStart === false ? '\n' : ''}${line}\n`;
    rec.streamPart = null;
    rec.lastOutputTail = (rec.lastOutputTail + text).slice(-TAIL_MAX);
    rec.lastActivity = Date.now();
    this._streamWrite(sessionId, text);
  }

  /** Follow a turn ZCode started by itself, like one the bridge started: live stream, status, wait. */
  _followTurn(sessionId, follow) {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.closed) return;
    if (rec.busy) { rec.pendingFollow = follow; return; }
    const turnId = this._nextTurnId();
    const run = this.runTurn(sessionId, follow.text, { follow, turnId, timeoutMs: this.asyncTurnTimeoutMs, detachOnTimeout: true, _reserved: true });
    const promise = run.then(() => this._turnView(sessionId, turnId), () => this._turnView(sessionId, turnId));
    rec.current = { turnId, promise, startedAt: rec.startedAt };
  }

  /**
   * After a turn: follow the turn that already started after it (a queued message), or, when queued
   * messages are left with nothing running, let ZCode drain them. ZCode drains its queue by itself after
   * turns started through V4; after a legacy session/send turn the queue waits until setAutoDrain
   * re-evaluates it.
   */
  _afterTurn(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (rec.pendingFollow) {
      const follow = rec.pendingFollow;
      rec.pendingFollow = null;
      this._followTurn(sessionId, follow);
      return;
    }
    const timer = setTimeout(() => {
      const r = this.sessions.get(sessionId);
      const state = this.v4.get(sessionId);
      if (!r || r.busy || r.closed || !state) return;
      if (state.phase === 'running' || !state.queue.autoDrain || v4.waitingTurns(state.queue).length === 0) return;
      this._v4Command(sessionId, 'setAutoDrain', { autoDrain: true }).catch((e) => this.log('queue drain kick failed', { sessionId, error: e.message }));
    }, 400);
    if (timer.unref) timer.unref();
  }

  /** Send one V4 command for a session; a compare-and-set command that lost the race is retried once. */
  async _v4Command(sessionId, type, payload) {
    const client = await this.ensureClient();
    const state = this.v4.get(sessionId) || v4.newState();
    let ack = await client.call('v4/command', v4.envelope({ clientId: this.v4ClientId, sessionId, type, payload, baseRevision: state.revision }), 30000);
    if (ack && ack.status === 'stale' && v4.CAS_COMMANDS.has(type)) {
      state.revision = Math.max(state.revision, ack.revisionAtDecision || 0);
      ack = await client.call('v4/command', v4.envelope({ clientId: this.v4ClientId, sessionId, type, payload, baseRevision: state.revision }), 30000);
    }
    if (ack && Number.isFinite(ack.revisionAtDecision)) state.revision = Math.max(state.revision, ack.revisionAtDecision);
    return ack;
  }

  /**
   * Send a message to a session whose turn is running: steer it (delivery guide — into the running turn
   * after its current tool step), queue it (its own turn once the current one ends), or interrupt the
   * turn with it (startNow). Resolves {sessionId, delivery, admitted, inputId, queueItemId, position}.
   */
  async sendInput(sessionId, text, { delivery } = {}) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    const requested = v4.deliveryOf(delivery, 'guide');
    if (!this.v4.get(sessionId) || !this.v4.get(sessionId).subscriptionId) {
      throw new Error(`session ${sessionId} has no V4 conversation subscription in this bridge, so it cannot take a message mid-turn; wait for the turn to end and send then`);
    }
    const ack = await this._v4Command(sessionId, 'sendText', { text: String(text || ''), requestedDelivery: requested });
    if (!ack || ack.status !== 'accepted') {
      throw new ProtocolError(`ZCode did not take the message (${(ack && ack.status) || 'no answer'}${ack && ack.reasonCode ? `: ${ack.reasonCode}` : ''}${ack && ack.message ? ` — ${ack.message}` : ''})`, { code: -32011, data: ack });
    }
    rec.lastActivity = Date.now();
    rec.lastUsedAt = rec.lastActivity;
    const result = ack.result || {};
    // ZCode names a queue item after its input: queue_<inputId>
    const queueItemId = result.inputId && requested !== 'startNow' ? `queue_${result.inputId}` : null;
    // the frame with the new queue item may trail the ACK by a beat
    let items = [];
    let index = -1;
    for (let i = 0; i < 10 && index < 0; i++) {
      await sleep(i ? 100 : 50);
      items = this.v4.get(sessionId).queue.items || [];
      index = queueItemId ? items.findIndex((it) => it.queueItemId === queueItemId) : -1;
      if (!queueItemId) break;
    }
    const item = index >= 0 ? items[index] : null;
    const admitted = (item && item.delivery && item.delivery.admitted) || (requested === 'startNow' ? (result.delivery || 'startNow') : requested);
    this._persistStatus(sessionId, { force: true, event: { event: 'input-sent', delivery: v4.DELIVERY_LABEL[requested], admitted: v4.DELIVERY_LABEL[admitted] || admitted, inputId: result.inputId } });
    return {
      sessionId,
      delivery: v4.DELIVERY_LABEL[requested],
      admitted: v4.DELIVERY_LABEL[admitted] || admitted,
      inputId: result.inputId || null,
      queueItemId: item ? item.queueItemId : queueItemId,
      position: index >= 0 ? index + 1 : null,
      queue: v4.queueSummary(this.v4.get(sessionId).queue),
    };
  }

  /** The session's input queue: {autoDrain, paused?, items: [{queueItemId, text, delivery, state}]}. */
  queueView(sessionId) {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    const state = this.v4.get(sessionId);
    return Object.assign({ sessionId, running: Boolean(this.sessions.get(sessionId).busy) }, v4.queueSummary(state && state.queue));
  }

  /**
   * Change the queue: delete | edit {text} | move {beforeQueueItemId|null = to the end} | send_now (only
   * while a turn runs: interrupts it and starts this item) | resume | pause (auto-drain after turns).
   */
  async queueOp(sessionId, action, { queueItemId, text, beforeQueueItemId } = {}) {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    const needItem = () => {
      if (!queueItemId) throw new Error(`queue_item_id is required for ${action} (zcode_session_queue action "list" shows them)`);
      return String(queueItemId);
    };
    let type;
    let payload;
    switch (action) {
      case 'delete': type = 'deleteQueueItem'; payload = { queueItemId: needItem() }; break;
      case 'edit':
        if (typeof text !== 'string' || !text.trim()) throw new Error('text is required for edit');
        type = 'editQueueItem'; payload = { queueItemId: needItem(), newText: text }; break;
      case 'move': type = 'reorderQueueItem'; payload = { queueItemId: needItem(), beforeQueueItemId: beforeQueueItemId ? String(beforeQueueItemId) : null }; break;
      case 'send_now': type = 'sendQueuedNow'; payload = { queueItemId: needItem() }; break;
      case 'resume': type = 'setAutoDrain'; payload = { autoDrain: true }; break;
      case 'pause': type = 'setAutoDrain'; payload = { autoDrain: false }; break;
      default: throw new Error(`unknown queue action "${action}": list, delete, edit, move, send_now, resume or pause`);
    }
    const ack = await this._v4Command(sessionId, type, payload);
    await sleep(150);
    const view = this.queueView(sessionId);
    if (!ack || ack.status !== 'accepted') {
      const why = `${(ack && ack.status) || 'no answer'}${ack && ack.reasonCode ? `: ${ack.reasonCode}` : ''}${ack && ack.message ? ` — ${ack.message}` : ''}`;
      throw new ProtocolError(`ZCode did not ${action} (${why})`, { code: -32012, data: { ack, queue: view } });
    }
    return Object.assign(view, { action, done: true });
  }

  _nextTurnId() {
    this._turnSeq += 1;
    return `turn-${this._turnSeq}-${Date.now().toString(36)}`;
  }

  /** Start a turn without waiting for it (async MCP turns). Returns
   *  {sessionId, turnId, status:'running'} synchronously; poll waitTurn() /
   *  sessionOutput(), or interrupt with cancelTurn(). The background promise
   *  always resolves (never rejects) — outcomes surface as status values.
   *  Async turns live under asyncTurnTimeoutMs (default 6 h) and, past that
   *  wait deadline, detach (status stays "running", `detached: true`) while
   *  the bridge keeps following the harness until the turn really ends. */
  startTurn(sessionId, text, opts = {}) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    if (rec.busy) {
      throw new ProtocolError(`a prompt is already running for session ${sessionId} (turnId ${rec.turnId || '?'})`, { code: -32010 });
    }
    const turnId = opts.turnId || this._nextTurnId();
    const run = this.runTurn(sessionId, text, Object.assign({}, opts, {
      turnId,
      timeoutMs: opts.timeoutMs || this.asyncTurnTimeoutMs,
      detachOnTimeout: true,
      _reserved: true,
    }));
    const promise = run.then(
      () => this._turnView(sessionId, turnId),
      () => this._turnView(sessionId, turnId) // state was recorded by _finishTurn
    );
    rec.current = { turnId, promise, startedAt: rec.startedAt };
    return { sessionId, turnId, status: 'running' };
  }

  /**
   * Block until the session's current turn finishes or timeoutMs passes.
   * Resolves {sessionId, turnId, status: running|done|error|cancelled|idle,
   * finalText (done), lastOutput, usage, model, error}.
   */
  async waitTurn(sessionId, timeoutMs = 60000) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    const cur = rec.current;
    if (cur && cur.promise) {
      const settled = await Promise.race([cur.promise, sleep(timeoutMs).then(() => null)]);
      if (settled) return settled;
      return this._turnView(sessionId, cur.turnId);
    }
    if (rec.busy) {
      // A blocking turn (HTTP facade path) holds the session; poll for its end.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(200);
        const r = this.sessions.get(sessionId);
        if (!r) return { sessionId, turnId: rec.turnId, status: 'error', error: 'session closed while waiting' };
        if (!r.busy) return this._turnView(sessionId, rec.turnId);
      }
      return this._turnView(sessionId, rec.turnId);
    }
    return this._turnView(sessionId, rec.turnId);
  }

  /** Latest streamed output without blocking: {sessionId, status, turnId, tail}. */
  sessionOutput(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    return {
      sessionId,
      status: rec.busy ? 'running' : (rec.status || 'idle'),
      turnId: rec.turnId,
      tail: String(rec.lastOutputTail || ''),
    };
  }

  /**
   * Cancel the running turn on a session. Interrupts via the app-server's
   * session/stop (the protocol's interrupt primitive); if that method is not
   * supported, stops and recreates the session instead. Either way the
   * session's status is recorded as "cancelled".
   */
  async cancelTurn(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId} (see zcode_sessions_list)`);
    const now = Date.now();
    rec.cancelRequested = true;
    rec.cancelledAt = now;
    rec.lastActivity = now;
    if (!rec.busy) {
      rec.status = 'cancelled';
      rec.finishedAt = now;
      this._persistStatus(sessionId, { force: true, event: { event: 'turn-cancelled', reason: 'no turn was running' } });
      return { sessionId, status: 'cancelled', interrupted: false, note: 'no turn was running' };
    }
    let interrupted = false;
    let recreated = null;
    try {
      const client = await this.ensureClient();
      await client.call('session/stop', { sessionId }, 15000);
      interrupted = true;
    } catch (e) {
      const unsupported = e instanceof ProtocolError && (e.code === -32601 || /not found|unknown method/i.test(e.message || ''));
      if (unsupported) {
        this.log('session/stop unsupported; stopping and recreating session', { sessionId });
        rec.status = 'cancelled';
        rec.finishedAt = Date.now();
        this._persistStatus(sessionId, { force: true, event: { event: 'turn-cancelled', turnId: rec.turnId, reason: 'session/stop unsupported; recreated' } });
        recreated = await this._recreateSession(sessionId).catch((e2) => {
          this.log('session recreate failed', { sessionId, error: e2.message });
          return null;
        });
      } else {
        this.log('session/stop failed during cancel', { sessionId, error: e.message });
      }
    }
    this._persistStatus(sessionId, { force: true, event: { event: 'cancel-requested', turnId: rec.turnId, interrupted } });
    if (recreated) return { sessionId, status: 'cancelled', interrupted: false, recreatedSessionId: recreated.sessionId };
    // a stop holds the queue (ZCode pauses auto-drain): say what waits, and how it runs again
    await sleep(300);
    const state = this.v4.get(sessionId);
    const waiting = state ? v4.waitingTurns(state.queue).length : 0;
    return Object.assign(
      { sessionId, status: 'cancelled', interrupted },
      waiting ? { queue: v4.queueSummary(state.queue), note: `${waiting} queued message(s) wait; ZCode holds the queue after a stop. zcode_session_queue action "resume" runs them, "delete" drops one.` } : {},
    );
  }

  /** Replace a session with a fresh one carrying the same workspace + model. */
  async _recreateSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId}`);
    const opts = { workspacePath: rec.workspacePath, model: rec.model };
    await this.closeSession(sessionId);
    return this.createSession(opts);
  }

  // ------------------------------------------------------ turn state -> disk
  _statusDoc(sessionId, rec) {
    return {
      id: sessionId,
      workspace: rec.workspacePath,
      model: rec.model,
      status: rec.status,
      turnId: rec.turnId,
      turns: rec.turns,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      lastActivity: rec.lastActivity,
      lastOutputTail: String(rec.lastOutputTail || '').slice(-TAIL_MAX),
      finalTextTail: String(rec.finalTextTail || '').slice(-TAIL_MAX),
      error: rec.error || null,
      usage: rec.usage
        ? { input: rec.usage.input || 0, output: rec.usage.output || 0, cacheRead: (rec.usage.cache && rec.usage.cache.read) || 0 }
        : null,
      pid: rec.pid,
      owner: this.ownerId,
      ...this._queueField(sessionId),
      ...(rec.adoptedFrom ? { adoptedFrom: rec.adoptedFrom } : {}),
      ...(rec.detached ? { detached: true, waitDeadlineHitAt: rec.waitDeadlineHitAt || null } : {}),
      ...(rec.closed ? { closed: true, closedAt: rec.closedAt } : {}),
    };
  }

  /** {queue} for a status document when something waits in the session's queue or the queue is paused. */
  _queueField(sessionId) {
    const state = this.v4.get(sessionId);
    if (!state || (!state.queue.items.length && state.queue.autoDrain)) return {};
    return { queue: v4.queueSummary(state.queue) };
  }

  _persistStatus(sessionId, { force = false, event = null } = {}) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    this.status.record(sessionId, this._statusDoc(sessionId, rec), { force, event });
  }

  // Text of a new part (a new model step) starts on a line of its own, in the tail and in the stream.
  _appendOutput(sessionId, chunk, partKey) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    const text = String(chunk || '');
    const sep = partKey && rec.streamPart && rec.streamPart !== partKey && !rec.streamAtLineStart ? '\n' : '';
    if (partKey) rec.streamPart = partKey;
    rec.lastOutputTail = (rec.lastOutputTail + sep + text).slice(-TAIL_MAX);
    rec.lastActivity = Date.now();
    this._streamWrite(sessionId, sep + text);
    this._persistStatus(sessionId, { event: { event: 'progress', chars: rec.lastOutputTail.length } });
  }

  _streamWrite(sessionId, text) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !text) return;
    this.status.appendStream(sessionId, text);
    rec.streamAtLineStart = text.endsWith('\n');
  }

  // One line per tool step the agent takes: when it first shows up, and again if it fails.
  _streamTool(sessionId, t) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    const failed = t.status === 'error';
    const line = `${failed ? '  ✗' : '  ↳'} ${t.tool}: ${toolSummary(t.input)}${failed && t.error ? ` — ${oneLine(t.error, 200)}` : ''}\n`;
    const text = (rec.streamAtLineStart ? '' : '\n') + line;
    rec.streamPart = `tool:${t.callID}`;
    rec.lastOutputTail = (rec.lastOutputTail + text).slice(-TAIL_MAX);
    rec.lastActivity = Date.now();
    this._streamWrite(sessionId, text);
  }

  _finishTurn(sessionId, turnId, kind, result, err) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    const now = Date.now();
    if (rec.current && rec.current.turnId === turnId) rec.current = null;
    rec.status = kind; // done | error | cancelled
    rec.finishedAt = now;
    rec.lastActivity = now;
    rec.lastUsedAt = now;
    if (result) {
      rec.finalTextTail = String(result.text || '').slice(-TAIL_MAX);
      rec.usage = result.usage || null;
      rec.error = null;
    } else {
      rec.finalTextTail = rec.lastOutputTail;
      rec.error = err ? String(err.message || err) : null;
    }
    // The final answer and the stream's footer land before the status says the turn ended, so a watcher
    // that sees the status change finds both.
    this.status.writeFinal(sessionId, result ? String(result.text || '') : (rec.error || rec.lastOutputTail || ''));
    const u = rec.usage;
    const tokens = u ? ` · in ${u.input || 0} / out ${u.output || 0}${u.cache && u.cache.read ? ` (cache read ${u.cache.read})` : ''}` : '';
    const took = rec.startedAt ? ` · ${Math.round((now - rec.startedAt) / 1000)} s` : '';
    this._streamWrite(sessionId, `${rec.streamAtLineStart === false ? '\n' : ''}── turn ${kind} ${clockOf(now)}${took}${tokens}${rec.error ? ` · ${oneLine(rec.error, 300)}` : ''} ──\n`);
    const event = { event: kind === 'done' ? 'turn-completed' : `turn-${kind}`, turnId };
    if (rec.error) event.error = rec.error;
    this._persistStatus(sessionId, { force: true, event });
  }

  /** Client-facing view of a session's current/last turn for wait/output. */
  _turnView(sessionId, turnId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return { sessionId, turnId, status: 'error', error: 'session closed' };
    const status = rec.busy ? 'running' : (rec.status || 'idle');
    const view = {
      sessionId,
      turnId: rec.turnId || turnId || null,
      status,
      lastOutput: String(rec.lastOutputTail || ''),
      model: rec.model,
    };
    if (status === 'done') view.finalText = rec.finalTextTail;
    if (status === 'error' && rec.error) view.error = rec.error;
    if (rec.detached) {
      view.detached = true;
      view.waitDeadlineHitAt = rec.waitDeadlineHitAt || null;
    }
    if (rec.usage) {
      view.usage = {
        input: rec.usage.input || 0,
        output: rec.usage.output || 0,
        cacheRead: (rec.usage.cache && rec.usage.cache.read) || 0,
      };
    }
    return view;
  }

  _watchTurn(msg, sessionId, opts) {
    if (!msg || typeof msg.method !== 'string') return;
    const p = msg.params || {};
    if (p.sessionId && p.sessionId !== sessionId) return;
    if (msg.method === 'session/event' && p.payload && p.payload.descriptor && opts.onToolActivity) {
      opts.onToolActivity({ kind: 'hook', display: p.payload.descriptor.commandDisplay || p.payload.descriptor.executionType });
    }
    if (msg.method === 'session/event' && p.payload && p.payload.error && opts.onToolActivity) {
      opts.onToolActivity({ kind: 'turn-error', error: p.payload.error.message || 'turn error' });
    }
  }

  async _awaitTurnEnd(client, sessionId, startedAt, opts) {
    // Async turns (detachOnTimeout) do NOT fail when the local wait deadline
    // passes: the harness turn keeps running (and editing files), so the
    // bridge detaches — status stays "running" with detached/waitDeadlineHitAt
    // — and keeps consuming notifications until the turn truly ends, letting
    // the status file reach done/error/cancelled with the real final text.
    let deadline = startedAt + (opts.timeoutMs || this.turnTimeoutMs);
    let detached = false;
      let sawTerminal = null; // {status, turnId, errorCode, errorMessage}
      let completionsSeen = 0;
      let lastStatus = null;
      let sawRunning = false;
      let sawModelCompleted = false;
      let idleSince = 0;
      const off = this.onNotification((msg) => {
        if (!msg || typeof msg.method !== 'string') return;
        const p = msg.params || {};
        if (msg.method === 'state.updated' && p.sessionId === sessionId && p.patch && p.patch.status) {
          if (p.patch.status === 'running') sawRunning = true;
          if (p.patch.status === 'idle' && sawRunning && !idleSince) idleSince = Date.now();
          if (p.patch.status !== lastStatus) {
            lastStatus = p.patch.status;
            this.log('session status', { sessionId, status: lastStatus });
          }
        }
        if (msg.method !== 'v4/telemetry/event') return;
        if (p.sessionId !== sessionId) return;
        if (p.kind === 'turn.terminal') {
          sawTerminal = { status: p.status, errorCode: p.errorCode, errorMessage: p.errorMessage };
          this.log('turn terminal', { sessionId, status: p.status, code: p.errorCode });
        } else if (p.kind === 'model.request.status') {
          if (p.status === 'model_request_completed') sawModelCompleted = true;
          this.log('model request status', { sessionId, status: p.status, attempt: p.attempt });
        }
      });

    let lastSnapshot = null;
    try {
      while (true) {
        if (opts.signal && opts.signal.aborted) {
          await this.stopSession(sessionId).catch(() => {});
          throw new TurnAborted(`client aborted (session ${sessionId})`);
        }
        if (Date.now() >= deadline) {
          if (!opts.detachOnTimeout) {
            throw new Error(
              `turn did not finish within ${Math.round((opts.timeoutMs || this.turnTimeoutMs) / 1000)}s`
              + ` (sessionId: ${sessionId}${opts.turnId ? `, turnId: ${opts.turnId}` : ''}; the turn may still be running —`
              + ` recover it with zcode_sessions_list / zcode_session_wait, or watch ${this.status.fileFor(sessionId)})`
            );
          }
          if (!detached) {
            detached = true;
            this._detachTurn(sessionId, opts.turnId);
            deadline = Infinity; // follow the harness until it reports the end
          }
        }
        // Cancel grace: cancelTurn() already sent session/stop; if the
        // harness never confirms with terminal telemetry, stop waiting.
        const recNow = this.sessions.get(sessionId);
        if (recNow && recNow.cancelRequested && recNow.cancelledAt && Date.now() - recNow.cancelledAt > 3000) {
          await this.stopSession(sessionId).catch(() => {});
          throw new TurnCancelled(`turn cancelled by client (session ${sessionId})`);
        }
        await sleep(sawTerminal ? 150 : 500);
        try {
          lastSnapshot = await this._pollMessages(client, sessionId, opts, lastSnapshot, startedAt);
        } catch (e) { this.log('poll failed', { error: e.message }); }
        // the turn's end by ZCode's turnId: recorded however early it arrived
        if (!sawTerminal) {
          const r = this.sessions.get(sessionId);
          const end = r && r.cliTurnId ? this.turnEnds.get(r.cliTurnId) : null;
          if (end) {
            const err = end.payload && end.payload.error;
            const cancelled = end.type === 'turn.failed' && err && /cancel/i.test(String(err.type || err.code || ''));
            sawTerminal = end.type === 'turn.completed'
              ? { status: 'completed' }
              : { status: cancelled ? 'cancelled' : 'failed', errorCode: err && err.code, errorMessage: err && err.message };
            this.log('turn end by turnId', { sessionId, cliTurnId: r.cliTurnId, status: sawTerminal.status });
          }
        }
        // Backstop: if the session went idle after a completed model request
        // but we somehow missed the terminal telemetry, extract anyway.
        if (!sawTerminal && idleSince && sawModelCompleted && Date.now() - idleSince > 2500) {
          const final = await this._extractResult(client, sessionId, startedAt, opts.endBefore);
          if (final) {
            this.log('turn resolved via idle backstop', { sessionId });
            return final;
          }
        }
        if (sawTerminal) {
          const st = String(sawTerminal.status || '');
          if (st === 'failed' || st === 'error' || st === 'cancelled') {
            const msg = `turn failed: ${sawTerminal.errorMessage || sawTerminal.errorCode || st || 'unknown error'} (session ${sessionId}, turnId ${opts.turnId || '?'})`;
            if (st === 'cancelled') throw new TurnCancelled(msg);
            throw new Error(msg);
          }
          if (st === 'completed' || st === 'success') {
            completionsSeen += 1;
            const final = await this._extractResult(client, sessionId, startedAt, opts.endBefore);
            if (final) return final;
            // Persistence can lag terminal by a beat; give it a few tries,
            // then resolve empty rather than hanging forever.
            if (completionsSeen >= 8) {
              return { sessionId, messageId: null, text: '', reasoning: '', usage: {}, finishReason: 'stop' };
            }
          }
        }
      }
    } finally {
      off();
    }
  }

  /** Mark a turn detached: the local wait deadline passed while the harness
   *  turn is still running. The status file keeps saying "running" (plus
   *  detached + waitDeadlineHitAt) and this bridge keeps following the turn
   *  to its real end; nothing is reported as an error here. */
  _detachTurn(sessionId, turnId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    rec.detached = true;
    rec.waitDeadlineHitAt = Date.now();
    this._persistStatus(sessionId, {
      force: true,
      event: {
        event: 'turn-detached',
        turnId: turnId || rec.turnId || null,
        note: 'local wait deadline passed; the harness turn is still running and is being followed to completion',
      },
    });
    this.log('async turn detached (wait deadline passed, still following)', { sessionId, turnId: turnId || rec.turnId });
  }

  async _pollMessages(client, sessionId, opts, lastSnapshot, startedAt) {
    const res = await client.call('session/messages', { sessionId, limit: 30 }, 30000);
    const messages = (res && res.messages) || [];
    return this._diffEmit(messages, lastSnapshot, opts, startedAt);
  }

  /** Emit incremental text for growing assistant parts. Returns new snapshot. */
  _diffEmit(messages, lastSnapshot, opts, startedAt) {
    const snap = new Map(); // `${messageID}:${part.id}` -> {type, len}
    const endBefore = opts.endBefore ? opts.endBefore() : Infinity;
    for (const m of messages) {
      if (!m || !m.parts || !m.info) continue;
      if (m.info.role !== 'assistant') continue;
      // Only live agent responses from THIS turn — imported history and
      // system timeline events must not be streamed back as new output.
      const created = m.info.time && m.info.time.created;
      const kind = m.info.semantics && m.info.semantics.kind;
      if (created === undefined || created < startedAt - 1500 || created >= endBefore) continue;
      if (kind && kind !== 'assistant_response') continue;
      for (const part of m.parts) {
        if (part.type === 'tool') {
          // a tool step: reported when first seen, and again if it ends in an error
          const key = `tool:${part.callID || part.id}`;
          const state = part.state || {};
          const status = state.status || 'pending';
          snap.set(key, { type: 'tool', status });
          const prev = lastSnapshot && lastSnapshot.get(key);
          const report = (!prev || (status === 'error' && prev.status !== 'error')) && opts.onTool;
          if (report) opts.onTool({ callID: part.callID || part.id, tool: part.tool || 'tool', status, input: state.input, title: state.title, error: state.error });
          continue;
        }
        if (part.type !== 'text' && part.type !== 'reasoning') continue;
        const key = `${part.messageID}:${part.id}`;
        const len = (part.text || '').length;
        snap.set(key, { type: part.type, len });
        const prev = lastSnapshot && lastSnapshot.get(key);
        if (!prev || prev.len < len) {
          const delta = (part.text || '').slice(prev ? prev.len : 0);
          if (delta && opts.onDelta) opts.onDelta({ type: part.type === 'reasoning' ? 'reasoning' : 'text', text: delta, key });
        }
      }
    }
    return snap;
  }

  async _extractResult(client, sessionId, startedAt, endBeforeOf) {
    const res = await client.call('session/messages', { sessionId, limit: 30 }, 30000);
    const messages = (res && res.messages) || [];
    const endBefore = endBeforeOf ? endBeforeOf() : Infinity;
    const candidates = messages.filter((m) => m && m.info && m.info.role === 'assistant'
      && m.info.semantics && m.info.semantics.kind === 'assistant_response'
      && (m.info.time && m.info.time.created >= startedAt - 1500 && m.info.time.created < endBefore));
    const asst = candidates[candidates.length - 1];
    if (!asst) return null;
    const texts = [];
    const reasoning = [];
    let usage = null;
    let finishReason = asst.info.finish || 'stop';
    for (const part of asst.parts || []) {
      if (part.type === 'text' && part.text) texts.push(part.text);
      if (part.type === 'reasoning' && part.text) reasoning.push(part.text);
      if (part.type === 'step-finish' && part.tokens) {
        usage = part.tokens;
        if (part.reason) finishReason = part.reason;
      }
    }
    if (!usage && asst.info.tokens) usage = asst.info.tokens;
    if (!texts.length && !reasoning.length) return null;
    return {
      sessionId,
      messageId: asst.info.id,
      text: texts.join('\n'),
      reasoning: reasoning.join('\n'),
      usage: usage || {},
      finishReason,
      errored: !!(asst.info.error),
      error: asst.info.error && (asst.info.error.data && asst.info.error.data.message || asst.info.error.name),
    };
  }

  // ------------------------------------------------------------ stop/close
  async stopSession(sessionId) {
    const client = this.client;
    if (!client || !client.running) return;
    try { await client.call('session/stop', { sessionId }, 15000); } catch { /* best effort */ }
  }

  async closeSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (rec) {
      rec.closed = true;
      rec.closedAt = Date.now();
      rec.lastActivity = Date.now();
      this._persistStatus(sessionId, { force: true, event: { event: 'session-closed' } });
    }
    this.sessions.delete(sessionId);
    this.v4.delete(sessionId);
    const client = this.client;
    if (!client || !client.running) return;
    try {
      await client.call('session/stop', { sessionId }, 15000).catch(() => {});
      await client.call('session/close', { sessionId }, 15000);
    } catch { /* best effort */ }
  }

  /**
   * Take over a session whose bridge process is gone: resume it from ZCode's own storage in this process's
   * app-server (session/resume), so a follow-up continues the same conversation. A turn that was running
   * when its owner died is not resumed; ZCode keeps its history, interrupted tool calls included.
   */
  async adoptSession(sessionId, { workspacePath, model, turns = 0, fromOwner = null } = {}) {
    if (this.sessions.has(sessionId)) return this.sessionInfo(sessionId);
    const client = await this.ensureClient();
    const wsPath = path.resolve(workspacePath || this.workspacePath);
    const workspace = { workspacePath: wsPath, workspaceKey: wsPath };
    const wanted = model && model.providerId ? model : this.defaultModel;
    if (!this.accountBootstrapped) {
      this.accountBootstrapped = true;
      await this._activateAccount(client, wanted.providerId, workspace);
    }
    await client.call('session/resume', { sessionId, workspace }, 90000);
    try {
      await client.call('session/setModel', { sessionId, model: { providerId: wanted.providerId, modelId: wanted.modelId, options: wanted.options || {} } }, 30000);
    } catch (e) { this.log('adopt: setModel failed (the session keeps its own)', { sessionId, error: e.message }); }
    try {
      await client.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, 15000);
    } catch (e) { this.log('subscribe failed (continuing)', { error: e.message }); }
    await this._v4Subscribe(client, sessionId, workspace);
    const now = Date.now();
    this.sessions.set(sessionId, {
      createdAt: now, lastUsedAt: now, turns, busy: false,
      workspacePath: wsPath, model: wanted,
      status: 'idle', turnId: null, startedAt: null, finishedAt: null,
      lastActivity: now, lastOutputTail: '', finalTextTail: '',
      error: null, usage: null, current: null,
      cancelRequested: false, cancelledAt: 0,
      pid: process.pid, adoptedFrom: fromOwner,
    });
    this._persistStatus(sessionId, { force: true, event: { event: 'session-adopted', from: fromOwner } });
    return this.sessionInfo(sessionId);
  }

  sessionInfo(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return null;
    const rest = Object.assign({}, rec);
    delete rest.current; // internal promise handle
    return Object.assign({ sessionId }, rest);
  }

  /**
   * Every session this process knows AND every session recorded on disk
   * (this or an earlier bridge process). Memory wins on id collision — it is
   * the live truth; disk-only entries keep whatever the file says.
   */
  sessionsList() {
    const byId = new Map();
    for (const doc of this.status.list()) {
      if (doc && doc.id) byId.set(String(doc.id), Object.assign({ inMemory: false }, doc));
    }
    for (const [id, rec] of this.sessions) {
      byId.set(id, {
        id,
        workspace: rec.workspacePath,
        model: rec.model,
        status: rec.busy ? 'running' : (rec.status || 'idle'),
        turns: rec.turns,
        createdAt: rec.createdAt,
        lastActivity: rec.lastActivity,
        turnId: rec.turnId,
        lastOutputTail: String(rec.lastOutputTail || '').slice(-TAIL_MAX),
        pid: rec.pid,
        owner: this.ownerId,
        ...this._queueField(id),
        inMemory: true,
      });
    }
    return [...byId.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }

  listSessions() { return [...this.sessions.entries()].map(([id, v]) => Object.assign({ sessionId: id }, v)); }

  /** Close sessions idle for > ms (default 30 min). Returns count closed. */
  async reapIdle(maxIdleMs = 30 * 60 * 1000) {
    const now = Date.now();
    let n = 0;
    for (const [id, rec] of [...this.sessions.entries()]) {
      if (rec.busy) continue;
      if (now - rec.lastUsedAt > maxIdleMs) {
        await this.closeSession(id);
        n += 1;
      }
    }
    return n;
  }

  async shutdown() {
    for (const [id] of [...this.sessions.entries()]) {
      await this.closeSession(id).catch(() => {});
    }
    if (this.client) await this.client.stop().catch(() => {});
  }
}

/** Flatten an Anthropic-style message list into claudeCode import format. */
function flattenHistory(messages) {
  const out = [];
  const push = (role, content) => {
    const s = String(content || '').trim();
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + s;
    else out.push({ role, content: s, timestamp: Date.now() });
  };
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    push(role, flattenContent(m.content));
  }
  return out;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') parts.push(b.text || '');
    else if (b.type === 'thinking') { if (b.thinking) parts.push(`[thinking] ${b.thinking}`); }
    else if (b.type === 'tool_use') parts.push(`[tool_use ${b.name}] ${safeJson(b.input)}`);
    else if (b.type === 'tool_result') {
      const inner = typeof b.content === 'string' ? b.content : flattenContent(b.content);
      parts.push(`[tool_result${b.is_error ? ' error' : ''}] ${inner}`);
    } else if (b.type === 'image') parts.push('[image omitted]');
    else parts.push(`[${b.type}]`);
  }
  return parts.filter((s) => String(s).trim()).join('\n');
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

/** Canonical message form for hashing: {role, text} with blocks flattened, so
 *  string-vs-block content encodings of the same text hash identically. */
function canonicalMessages(messages) {
  return (messages || []).map((m) => ({ role: m && m.role, text: flattenContent(m && m.content) }));
}

function hashPrefix(system, messages) {
  const h = crypto.createHash('sha256');
  h.update(String(system || ''));
  h.update('\u0000');
  h.update(JSON.stringify(canonicalMessages(messages)));
  return h.digest('hex');
}

/** Key the conversation will have once the client appends our reply text. */
function followKey(system, messages, replyText) {
  return hashPrefix(system, [...(messages || []), { role: 'assistant', content: replyText || '' }]);
}

module.exports = { AgentManager, TurnAborted, TurnCancelled, flattenHistory, flattenContent, hashPrefix, followKey, canonicalMessages };
