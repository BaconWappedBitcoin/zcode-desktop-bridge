#!/usr/bin/env node
'use strict';
/** test/reset-policy.cjs — banked 5-hour reset policy over mocked snapshots (no network, no resets spent).
 *  Style follows test/plan-router.cjs: PASS/FAIL lines, exit 1 on any failure. */
const rp = require('../lib/reset-policy.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}
const NOW = Date.parse('2026-10-07T05:00:00Z');
const snap = ({ fivePct = 100, mins = 180, weekRem = 100000, weekPct = 30, banked = 2, nextReset = true } = {}) => ({
  quota: { limits: [
    { window: 'five_hour', usedPercentage: fivePct, remaining: 0, nextResetTime: nextReset ? new Date(NOW + mins * 60000).toISOString() : null },
    { window: 'week', usedPercentage: weekPct, remaining: weekRem },
  ] },
  resets: { available: { five_hour: Array.from({ length: banked }, () => ({ expireAt: '2026-10-28T15:32:51Z' })), week: [] } },
});
const ev = (s, policy, queuedWork = true) => rp.evaluate(s, policy, { queuedWork, now: NOW });

let r = ev(snap(), {});
check('spends when exhausted, far from reset, week has room, work queued', r.spend, r.reasons.join('; '));
check('reports minutes saved', r.minutesSaved === 180, String(r.minutesSaved));

r = ev(snap({ mins: 40 }), {});
check('waits when natural reset is < 60 min away', !r.spend && r.reasons.some((x) => x.includes('natural reset in 40')), r.reasons.join('; '));

r = ev(snap({ mins: 40 }), { minMinutesToNaturalReset: 30 });
check('threshold is configurable', r.spend, r.reasons.join('; '));

r = ev(snap({ fivePct: 60 }), {});
check('waits when the 5-hour window still has credit', !r.spend && r.reasons.some((x) => x.includes('60% used')));

r = ev(snap({ weekPct: 99, weekRem: 900 }), {});
check('waits when the week is the binding limit', !r.spend && r.reasons.some((x) => x.includes('binding limit')));

r = ev(snap(), {}, false);
check('waits when no work is queued', !r.spend && r.reasons.some((x) => x.includes('queued')));

r = ev(snap(), { requireQueuedWork: false }, false);
check('queued-work requirement can be switched off', r.spend);

r = ev(snap({ banked: 0 }), {});
check('waits with no banked reset', !r.spend && r.reasons.some((x) => x.includes('banked 0')));

r = ev(snap({ banked: 1 }), { keepBanked: 1 });
check('keepBanked reserves the last reset', !r.spend);

r = ev(snap(), { enabled: false });
check('disabled policy never spends', !r.spend && r.reasons[0].includes('disabled'));

r = ev(snap({ nextReset: false }), {});
check('idle window without a reset clock is not reset', !r.spend && r.reasons.some((x) => x.includes('no running reset clock')));

r = ev({ quota: { error: 'boom' }, resets: {} }, {});
check('fails closed when quota cannot be read', !r.spend);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
