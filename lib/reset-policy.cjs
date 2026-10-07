'use strict';
/**
 * lib/reset-policy.cjs — should a banked 5-hour reset be spent right now? (owner 2026-10-06:
 * "calculate that if you're close to the reset windows anyway, don't reset").
 *
 * A banked reset only buys back the time until the NATURAL 5-hour reset, so it is worth spending
 * only when the window is (nearly) exhausted, work is actually waiting, the natural reset is far
 * enough away, and the weekly window still has room (a 5-hour reset cannot help when the week is
 * the binding limit). Pure: takes a plan snapshot (coding-plan.getPlanSnapshot shape) + policy.
 *
 * config.json "resetPolicy" (all optional; defaults below):
 *   enabled                    false -> evaluate() always says no (manual resets only)
 *   minFiveHourUsedPct         5-hour window usage needed before a reset is considered (98)
 *   minMinutesToNaturalReset   do not reset when the natural reset is closer than this (60)
 *   minWeeklyRemaining         weekly credits that must remain (0)
 *   minWeeklyRemainingPct      weekly % that must remain (2)
 *   requireQueuedWork          only when the caller says work is queued/stalled (true)
 *   keepBanked                 never spend the last N banked resets (0)
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  minFiveHourUsedPct: 98,
  minMinutesToNaturalReset: 60,
  minWeeklyRemaining: 0,
  minWeeklyRemainingPct: 2,
  requireQueuedWork: true,
  keepBanked: 0,
});

function resolvePolicy(policy) {
  return Object.assign({}, DEFAULTS, policy || {});
}

function windowOf(snapshot, name) {
  const limits = (snapshot && snapshot.quota && snapshot.quota.limits) || (snapshot && snapshot.limits) || [];
  return limits.find((l) => l.window === name) || null;
}

function bankedFiveHour(snapshot) {
  const av = snapshot && snapshot.resets && snapshot.resets.available;
  if (!av) return 0;
  const list = av.five_hour || av.FIVE_HOUR || [];
  return Array.isArray(list) ? list.length : Number(list) || 0;
}

/**
 * @param {object} snapshot  getPlanSnapshot() result ({quota:{limits:[...]}, resets:{available:{five_hour:[...]}}})
 * @param {object} policy    config.resetPolicy
 * @param {object} opts      { queuedWork: boolean, now: Date|number }
 * @returns {{spend:boolean, reasons:string[], minutesSaved:number|null, fiveHourUsedPct:number|null,
 *            weeklyRemaining:number|null, weeklyRemainingPct:number|null, banked:number, policy:object}}
 */
function evaluate(snapshot, policy, opts = {}) {
  const p = resolvePolicy(policy);
  const now = opts.now instanceof Date ? opts.now.getTime() : (Number(opts.now) || Date.now());
  const reasons = [];
  const five = windowOf(snapshot, 'five_hour');
  const week = windowOf(snapshot, 'week');
  const banked = bankedFiveHour(snapshot);

  const fiveUsed = five ? Number(five.usedPercentage) : null;
  let minutesSaved = null;
  if (five && five.nextResetTime) {
    const t = Date.parse(five.nextResetTime);
    if (!Number.isNaN(t)) minutesSaved = Math.max(0, Math.round((t - now) / 60000));
  }
  const weekRem = week ? Number(week.remaining) : null;
  const weekRemPct = week ? Math.max(0, 100 - Number(week.usedPercentage)) : null;

  if (!p.enabled) reasons.push('policy disabled (resetPolicy.enabled=false)');
  if (banked <= p.keepBanked) reasons.push(`no spendable banked 5-hour reset (banked ${banked}, keepBanked ${p.keepBanked})`);
  if (!five) reasons.push('5-hour window unknown (quota read failed)');
  else if (!(fiveUsed >= p.minFiveHourUsedPct)) reasons.push(`5-hour window only ${fiveUsed}% used (< ${p.minFiveHourUsedPct}%)`);
  if (minutesSaved === null) {
    // No nextResetTime: an idle window has no running clock, so a reset would buy nothing.
    if (five) reasons.push('5-hour window has no running reset clock');
  } else if (minutesSaved < p.minMinutesToNaturalReset) {
    reasons.push(`natural reset in ${minutesSaved} min (< ${p.minMinutesToNaturalReset} min): wait instead`);
  }
  if (!week) reasons.push('weekly window unknown');
  else {
    if (weekRem !== null && weekRem <= p.minWeeklyRemaining) reasons.push(`weekly remaining ${weekRem} <= ${p.minWeeklyRemaining}: the week is the binding limit`);
    if (weekRemPct !== null && weekRemPct < p.minWeeklyRemainingPct) reasons.push(`weekly remaining ${weekRemPct}% < ${p.minWeeklyRemainingPct}%: the week is the binding limit`);
  }
  if (p.requireQueuedWork && !opts.queuedWork) reasons.push('no queued/stalled work reported (pass queuedWork:true)');

  return {
    spend: reasons.length === 0,
    reasons: reasons.length ? reasons : ['all conditions met'],
    minutesSaved,
    fiveHourUsedPct: fiveUsed,
    weeklyRemaining: weekRem,
    weeklyRemainingPct: weekRemPct,
    banked,
    policy: p,
  };
}

module.exports = { evaluate, resolvePolicy, DEFAULTS };
