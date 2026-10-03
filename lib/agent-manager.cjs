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
const harnessEnv = require('./harness-env.cjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class TurnAborted extends Error {
  constructor(reason) { super(reason || 'turn aborted'); this.name = 'TurnAborted'; }
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
    this.mode = cfg.mode || 'yolo';
    this.turnTimeoutMs = cfg.turnTimeoutMs || 15 * 60 * 1000;
    this.client = null;
    this.accountBootstrapped = false;
    this.sessions = new Map(); // sessionId -> {createdAt, lastUsedAt, turns, busy}
    this._notificationHandlers = new Set();
    this._starting = null;
  }

  onNotification(fn) { this._notificationHandlers.add(fn); return () => this._notificationHandlers.delete(fn); }

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
      || models[0];
    if (!entry) throw new Error('no models available in the harness registry (account bootstrap failed?)');
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

    this.sessions.set(sessionId, { createdAt: Date.now(), lastUsedAt: Date.now(), turns: 0, busy: false, workspacePath, model: modelSelection });
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
    if (!String(primaryPid || '').startsWith('account:')) return null;
    const credPids = [...new Set([primaryPid, ...harnessEnv.listPlanCredentials().map((p) => p.providerId)])]
      .filter((p) => String(p).startsWith('account:'));

    const cacheFile = path.join(__dirname, '..', 'out', '.builtin-revision.json');
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).basedOn; } catch { /* none */ }
    const candidates = [];
    const seen = new Set();
    for (const c of [cached, ...harnessEnv.builtinRevisionCandidates()]) {
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
    const created = await this.createSession();
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
   * Resolves {sessionId, messageId, text, reasoning, usage, finishReason}.
   */
  async runTurn(sessionId, text, opts = {}) {
    const client = await this.ensureClient();
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session ${sessionId}`);
    if (rec.busy) throw new ProtocolError('A prompt is already running for this session', { code: -32010 });
    rec.busy = true;
    rec.turns += 1;
    rec.lastUsedAt = Date.now();

    const startedAt = Date.now();
    const offNotification = this.onNotification((msg) => this._watchTurn(msg, sessionId, opts));
    let result;
    try {
      const sendR = await client.call('session/send', { sessionId, content: text }, 60000);
      if (!sendR || !sendR.accepted) throw new Error('session/send was not accepted');
      result = await this._awaitTurnEnd(client, sessionId, startedAt, opts);
    } finally {
      offNotification();
      if (this.sessions.has(sessionId)) this.sessions.get(sessionId).busy = false;
    }
    return result;
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
    const deadline = startedAt + (opts.timeoutMs || this.turnTimeoutMs);
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
      while (Date.now() < deadline) {
        if (opts.signal && opts.signal.aborted) {
          await this.stopSession(sessionId).catch(() => {});
          throw new TurnAborted('client aborted');
        }
        await sleep(sawTerminal ? 150 : 500);
        try {
          lastSnapshot = await this._pollMessages(client, sessionId, opts, lastSnapshot, startedAt);
        } catch (e) { this.log('poll failed', { error: e.message }); }
        // Backstop: if the session went idle after a completed model request
        // but we somehow missed the terminal telemetry, extract anyway.
        if (!sawTerminal && idleSince && sawModelCompleted && Date.now() - idleSince > 2500) {
          const final = await this._extractResult(client, sessionId, startedAt);
          if (final) {
            this.log('turn resolved via idle backstop', { sessionId });
            return final;
          }
        }
        if (sawTerminal) {
          const st = String(sawTerminal.status || '');
          if (st === 'failed' || st === 'error' || st === 'cancelled') {
            throw new Error(`turn failed: ${sawTerminal.errorMessage || sawTerminal.errorCode || st || 'unknown error'}`);
          }
          if (st === 'completed' || st === 'success') {
            completionsSeen += 1;
            const final = await this._extractResult(client, sessionId, startedAt);
            if (final) return final;
            // Persistence can lag terminal by a beat; give it a few tries,
            // then resolve empty rather than hanging until the deadline.
            if (completionsSeen >= 8) {
              return { sessionId, messageId: null, text: '', reasoning: '', usage: {}, finishReason: 'stop' };
            }
          }
        }
      }
      throw new Error(`turn did not finish within ${Math.round((opts.timeoutMs || this.turnTimeoutMs) / 1000)}s`);
    } finally {
      off();
    }
  }

  async _pollMessages(client, sessionId, opts, lastSnapshot, startedAt) {
    const res = await client.call('session/messages', { sessionId, limit: 30 }, 30000);
    const messages = (res && res.messages) || [];
    return this._diffEmit(messages, lastSnapshot, opts, startedAt);
  }

  /** Emit incremental text for growing assistant parts. Returns new snapshot. */
  _diffEmit(messages, lastSnapshot, opts, startedAt) {
    const snap = new Map(); // `${messageID}:${part.id}` -> {type, len}
    for (const m of messages) {
      if (!m || !m.parts || !m.info) continue;
      if (m.info.role !== 'assistant') continue;
      // Only live agent responses from THIS turn — imported history and
      // system timeline events must not be streamed back as new output.
      const created = m.info.time && m.info.time.created;
      const kind = m.info.semantics && m.info.semantics.kind;
      if (created === undefined || created < startedAt - 1500) continue;
      if (kind && kind !== 'assistant_response') continue;
      for (const part of m.parts) {
        if (part.type !== 'text' && part.type !== 'reasoning') continue;
        const key = `${part.messageID}:${part.id}`;
        const len = (part.text || '').length;
        snap.set(key, { type: part.type, len });
        const prev = lastSnapshot && lastSnapshot.get(key);
        if (!prev || prev.len < len) {
          const delta = (part.text || '').slice(prev ? prev.len : 0);
          if (delta && opts.onDelta) opts.onDelta({ type: part.type === 'reasoning' ? 'reasoning' : 'text', text: delta });
        }
      }
    }
    return snap;
  }

  async _extractResult(client, sessionId, startedAt) {
    const res = await client.call('session/messages', { sessionId, limit: 30 }, 30000);
    const messages = (res && res.messages) || [];
    const candidates = messages.filter((m) => m && m.info && m.info.role === 'assistant'
      && m.info.semantics && m.info.semantics.kind === 'assistant_response'
      && (m.info.time && m.info.time.created >= startedAt - 1500));
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
    const client = this.client;
    this.sessions.delete(sessionId);
    if (!client || !client.running) return;
    try {
      await client.call('session/stop', { sessionId }, 15000).catch(() => {});
      await client.call('session/close', { sessionId }, 15000);
    } catch { /* best effort */ }
  }

  sessionInfo(sessionId) { return this.sessions.get(sessionId) || null; }
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

module.exports = { AgentManager, TurnAborted, flattenHistory, flattenContent, hashPrefix, followKey, canonicalMessages };
