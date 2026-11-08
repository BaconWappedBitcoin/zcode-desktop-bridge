'use strict';
/**
 * v4-commands.cjs — the pieces of ZCode's V4 conversation protocol the bridge uses to talk to a session
 * while a turn runs: command envelopes (v4/command), delivery names, and the session state carried by
 * v4/conversation/frame notifications (revision, phase, input queue).
 *
 * A message sent to a running session is a V4 sendText with requestedDelivery:
 *   guide    → steer: held until the current tool step finishes, then injected into the running turn
 *              (the model sees it as "The user sent a new message while you were working"); ZCode falls
 *              back to the queue when the turn ends without another tool step;
 *   queue    → runs as its own turn when the current one ends (the session's queue drains in order);
 *   startNow → interrupts the running turn and starts a new one with this message.
 * Commands that edit the queue are compare-and-set: their envelope carries the session's current
 * revision (baseRevision), which frames keep up to date.
 */
const crypto = require('crypto');

// command types whose envelope must carry baseRevision (ZCode packages/shared zcode-protocol-v4/command.ts)
const CAS_COMMANDS = new Set([
  'applyFileRewind', 'forkAssistant', 'editUserQuery', 'retryTurn', 'setAssistantFeedback', 'sendQueuedNow',
  'editQueueItem', 'reorderQueueItem', 'deleteQueueItem', 'setAutoDrain', 'switchModelConfig',
  'switchCollaborationMode', 'setFollowupMode', 'pauseGoal', 'resumeGoal',
]);

/** A UUID v7 (time-ordered), as V4 command ids are. */
function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DELIVERY_WORDS = {
  steer: 'guide', guide: 'guide',
  queue: 'queue', queued: 'queue', next: 'queue',
  interrupt: 'startNow', now: 'startNow', startnow: 'startNow',
};
/** The V4 delivery for a word a client uses: steer|guide → guide, queue → queue, interrupt|now → startNow. */
function deliveryOf(word, fallback = 'guide') {
  if (word == null || word === '') return fallback;
  const d = DELIVERY_WORDS[String(word).trim().toLowerCase()];
  if (!d) throw new Error(`unknown delivery "${word}": use steer, queue or interrupt`);
  return d;
}
const DELIVERY_LABEL = { guide: 'steer', queue: 'queue', startNow: 'interrupt' };

/** A v4/command envelope. baseRevision is set for compare-and-set commands (and only for them). */
function envelope({ clientId, sessionId, type, payload, baseRevision, now = Date.now(), commandId }) {
  const env = { commandId: commandId || uuidv7(now), clientId, sessionId, type, payload: payload || {}, issuedAt: now };
  if (CAS_COMMANDS.has(type)) env.baseRevision = Number.isFinite(baseRevision) ? baseRevision : 0;
  return env;
}

/** A fresh per-session state, filled in by applyFrame(). */
const newState = () => ({ revision: 0, phase: null, queue: { items: [], autoDrain: true }, subscriptionId: null, snapshotAt: 0 });

/**
 * Fold one v4/conversation/frame into a session state: the snapshot replaces it, state.updated deltas
 * patch it (rows are not kept). Returns what changed: {queue, phase}.
 */
function applyFrame(state, frame) {
  const changed = { queue: false, phase: false };
  const payload = frame && frame.payload;
  if (!payload) return changed;
  const take = (patch) => {
    if (!patch || typeof patch !== 'object') return;
    if (Number.isFinite(patch.revision)) state.revision = patch.revision;
    if (patch.control && typeof patch.control.phase === 'string' && patch.control.phase !== state.phase) {
      state.phase = patch.control.phase;
      changed.phase = true;
    }
    if (patch.queue && typeof patch.queue === 'object') {
      state.queue = { items: Array.isArray(patch.queue.items) ? patch.queue.items : [], autoDrain: patch.queue.autoDrain !== false, ...(patch.queue.pauseReason ? { pauseReason: patch.queue.pauseReason } : {}) };
      changed.queue = true;
    }
  };
  if (payload.kind === 'snapshot') {
    take(payload.snapshot);
    state.snapshotAt = Date.now();
    changed.queue = true;
  } else if (payload.kind === 'deltas') {
    for (const d of payload.deltas || []) if (d && d.op === 'state.updated') take(d.patch);
  }
  return changed;
}

/**
 * v4/conversation/frame notifications are wire envelopes around a logical frame: kind "complete" carries it
 * as `frame`; a large one is split into kind "fragment" pieces ({logicalFrameId, fragmentIndex,
 * fragmentCount, dataBase64}) that join, in order, into the frame's JSON. accept(wire) returns the logical
 * frame once it is whole, else null.
 */
function createFrameAssembler({ maxPending = 64 } = {}) {
  const pending = new Map(); // logicalFrameId -> {count, parts: Buffer[], got}
  return {
    accept(wire) {
      if (!wire || typeof wire !== 'object') return null;
      if (wire.kind === 'complete' || (wire.frame && wire.kind === undefined)) return wire.frame || null;
      if (wire.payload && wire.kind === undefined) return wire; // an unwrapped frame
      if (wire.kind !== 'fragment' || !wire.logicalFrameId) return null;
      let entry = pending.get(wire.logicalFrameId);
      if (!entry) {
        if (pending.size >= maxPending) pending.delete(pending.keys().next().value);
        entry = { count: Number(wire.fragmentCount) || 1, parts: [], got: 0 };
        pending.set(wire.logicalFrameId, entry);
      }
      const i = Number(wire.fragmentIndex);
      if (!Number.isInteger(i) || i < 0 || i >= entry.count || entry.parts[i]) return null;
      entry.parts[i] = Buffer.from(String(wire.dataBase64 || ''), 'base64');
      entry.got += 1;
      if (entry.got < entry.count) return null;
      pending.delete(wire.logicalFrameId);
      try { return JSON.parse(Buffer.concat(entry.parts).toString('utf8')); } catch { return null; }
    },
    pendingCount: () => pending.size,
  };
}

const sessionOfTopic = (topic) => (typeof topic === 'string' && topic.startsWith('conversation/') ? topic.slice('conversation/'.length) : null);

/** The queue as clients see it: {autoDrain, paused?, items: [{queueItemId, text, delivery, state}]}. */
function queueSummary(queue) {
  const q = queue || { items: [], autoDrain: true };
  return {
    autoDrain: q.autoDrain !== false,
    ...(q.autoDrain === false ? { paused: q.pauseReason || 'manual' } : {}),
    items: (q.items || []).map((it) => ({
      queueItemId: it.queueItemId,
      text: String(it.text || ''),
      delivery: DELIVERY_LABEL[(it.delivery && (it.delivery.admitted || it.delivery.requested)) || 'queue'] || 'queue',
      state: (it.dispatch && it.dispatch.state) || 'queued',
    })),
  };
}

/** Items that will run as turns of their own (not steers waiting for a tool boundary). */
const waitingTurns = (queue) => (queue && queue.items ? queue.items.filter((it) => !it.delivery || it.delivery.admitted !== 'guide') : []);

module.exports = { CAS_COMMANDS, uuidv7, deliveryOf, DELIVERY_LABEL, envelope, newState, applyFrame, createFrameAssembler, sessionOfTopic, queueSummary, waitingTurns };
