#!/usr/bin/env node
'use strict';
// Offline tests for lib/v4-commands.cjs: delivery names, command envelopes (compare-and-set revision),
// folding conversation frames into session state, fragment assembly, the queue summary.
const assert = require('assert');
const v4 = require('../lib/v4-commands.cjs');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok   ${name}`); };

t('delivery words map to V4 deliveries', () => {
  assert.strictEqual(v4.deliveryOf('steer'), 'guide');
  assert.strictEqual(v4.deliveryOf('guide'), 'guide');
  assert.strictEqual(v4.deliveryOf('queue'), 'queue');
  assert.strictEqual(v4.deliveryOf('interrupt'), 'startNow');
  assert.strictEqual(v4.deliveryOf('NOW'), 'startNow');
  assert.strictEqual(v4.deliveryOf(undefined), 'guide');
  assert.strictEqual(v4.deliveryOf('', 'queue'), 'queue');
  assert.throws(() => v4.deliveryOf('later'), /unknown delivery/);
});

t('uuidv7 is a version-7 UUID that sorts by time', () => {
  const a = v4.uuidv7(1000);
  const b = v4.uuidv7(2000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

t('envelopes carry baseRevision only for compare-and-set commands', () => {
  const send = v4.envelope({ clientId: 'c', sessionId: 's', type: 'sendText', payload: { text: 'x' }, baseRevision: 7, now: 5 });
  assert.strictEqual(send.baseRevision, undefined);
  assert.strictEqual(send.issuedAt, 5);
  assert.deepStrictEqual(send.payload, { text: 'x' });
  const del = v4.envelope({ clientId: 'c', sessionId: 's', type: 'deleteQueueItem', payload: { queueItemId: 'q' }, baseRevision: 7 });
  assert.strictEqual(del.baseRevision, 7);
  assert.strictEqual(v4.envelope({ clientId: 'c', sessionId: 's', type: 'setAutoDrain', payload: {} }).baseRevision, 0);
  assert.ok(v4.CAS_COMMANDS.has('sendQueuedNow') && !v4.CAS_COMMANDS.has('stop'));
});

const item = (id, text, admitted = 'queue', state = 'queued') => ({ queueItemId: id, text, delivery: { requested: admitted, admitted }, dispatch: { state } });

t('a snapshot sets revision, phase and queue; deltas patch them; rows are ignored', () => {
  const s = v4.newState();
  let c = v4.applyFrame(s, { payload: { kind: 'snapshot', snapshot: { revision: 3, control: { phase: 'draft' }, queue: { items: [], autoDrain: true }, rows: { window: [] } } } });
  assert.deepStrictEqual([s.revision, s.phase, s.queue.items.length], [3, 'draft', 0]);
  assert.ok(c.queue && c.phase);
  c = v4.applyFrame(s, { payload: { kind: 'deltas', deltas: [
    { op: 'state.updated', patch: { revision: 4, control: { phase: 'running' } } },
    { op: 'row.appended', row: { rowId: 1 } },
    { op: 'state.updated', patch: { revision: 5, queue: { items: [item('q1', 'later')], autoDrain: true } } },
  ] } });
  assert.deepStrictEqual([s.revision, s.phase, s.queue.items.length], [5, 'running', 1]);
  assert.ok(c.queue && c.phase);
  c = v4.applyFrame(s, { payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { revision: 6 } }] } });
  assert.ok(!c.queue && !c.phase);
  assert.strictEqual(s.revision, 6);
  v4.applyFrame(s, { payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { queue: { items: [], autoDrain: false, pauseReason: 'stopped' } } }] } });
  assert.deepStrictEqual(s.queue, { items: [], autoDrain: false, pauseReason: 'stopped' });
});

t('frames are routed by topic', () => {
  assert.strictEqual(v4.sessionOfTopic('conversation/sess_1'), 'sess_1');
  assert.strictEqual(v4.sessionOfTopic('sessions-index/w'), null);
});

t('complete wires unwrap, fragments join in any order', () => {
  const asm = v4.createFrameAssembler();
  const frame = { topic: 'conversation/s', payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { revision: 9, note: 'é'.repeat(50) } }] } };
  assert.deepStrictEqual(asm.accept({ wireVersion: 1, kind: 'complete', topic: 'conversation/s', subscriptionId: 'x', frame }), frame);
  const bytes = Buffer.from(JSON.stringify(frame), 'utf8');
  const cut = [0, 17, 41, bytes.length];
  const parts = [0, 1, 2].map((i) => ({ wireVersion: 1, kind: 'fragment', logicalFrameId: 'f1', topic: 'conversation/s', subscriptionId: 'x', fragmentIndex: i, fragmentCount: 3, dataBase64: bytes.subarray(cut[i], cut[i + 1]).toString('base64') }));
  assert.strictEqual(asm.accept(parts[2]), null);
  assert.strictEqual(asm.accept(parts[0]), null);
  assert.strictEqual(asm.accept(parts[0]), null, 'a repeated fragment is ignored');
  assert.deepStrictEqual(asm.accept(parts[1]), frame);
  assert.strictEqual(asm.pendingCount(), 0);
});

t('the queue summary names deliveries the way clients send them', () => {
  const q = v4.queueSummary({ items: [item('q1', 'steer me', 'guide'), item('q2', 'next turn')], autoDrain: false, pauseReason: 'stopped' });
  assert.deepStrictEqual(q, {
    autoDrain: false,
    paused: 'stopped',
    items: [
      { queueItemId: 'q1', text: 'steer me', delivery: 'steer', state: 'queued' },
      { queueItemId: 'q2', text: 'next turn', delivery: 'queue', state: 'queued' },
    ],
  });
  assert.deepStrictEqual(v4.queueSummary(null), { autoDrain: true, items: [] });
  assert.deepStrictEqual(v4.waitingTurns({ items: [item('q1', 'a', 'guide'), item('q2', 'b')] }).map((i) => i.queueItemId), ['q2']);
});

console.log(`\n${n} passed`);
