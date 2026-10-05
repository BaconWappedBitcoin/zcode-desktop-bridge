#!/usr/bin/env node
'use strict';
/** test/plan-router.cjs — routing policy over mocked quota (no network, no quota spent).
 *  Style follows test/mcp-smoke.cjs: PASS/FAIL lines, exit 1 on any failure. */
const router = require('../lib/plan-router.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}
const IND = 'account:zai-individual-coding-plan', TEAM = 'account:zai-team-coding-plan', START = 'account:zai-start-plan';
const catalog = [
  { providerId: IND, models: ['GLM-5.3', 'GLM-5.3-Flash'] },
  { providerId: TEAM, models: ['GLM-5.3', 'GLM-5.3-Flash'] },
  { providerId: START, models: ['GLM-5.3-Flash'] },
];
const q = (five, weekUsedPct, weekRemaining) => ({ limits: [
  { window: 'five_hour', remaining: five, usedPercentage: 0, nextResetTime: '2026-10-05T22:16:17Z' },
  { window: 'week', remaining: weekRemaining, usedPercentage: weekUsedPct, nextResetTime: '2026-10-11T11:09:07Z' },
] });

(async () => {
  router.clearCache();
  // 1. Flash with healthy individual plan -> individual (start plan excluded as desktop-only)
  let r = await router.route('GLM-5.3-Flash', { catalog, creds: [{ providerId: IND }], getQuota: async () => q(1000, 50, 5000) });
  check('flash routes to individual when it has credit', r.providerId === IND, r.reason);
  check('start plan listed as desktop-only', r.candidates.find((c) => c.providerId === START).why.includes('desktop-app only'));

  // 2. weekly reserve keeps the last slice of the individual plan for GLM-5.3
  router.clearCache();
  r = await router.route('GLM-5.3-Flash', { catalog, creds: [{ providerId: IND }], getQuota: async () => q(1000, 95, 100) });
  check('flash refused by weekly reserve at 5% left', r.providerId === null && /reserve/.test(r.candidates.find((c) => c.providerId === IND).why), r.reason);
  router.clearCache();
  r = await router.route('GLM-5.3', { catalog, creds: [{ providerId: IND }], getQuota: async () => q(1000, 95, 100) });
  check('GLM-5.3 still allowed inside the reserve', r.providerId === IND, r.reason);

  // 3. exhausted 5-hour -> waitUntil, falls through to team when credentialed
  router.clearCache();
  const quotas = { [IND]: q(0, 50, 5000), [TEAM]: q(500, 10, 9000) };
  r = await router.route('GLM-5.3', { catalog, creds: [{ providerId: IND }, { providerId: TEAM }], getQuota: async (pid) => quotas[pid] });
  check('falls through to team when individual 5h is exhausted', r.providerId === TEAM, r.reason);
  router.clearCache();
  r = await router.route('GLM-5.3', { catalog, creds: [{ providerId: IND }], getQuota: async () => q(0, 50, 5000) });
  check('nothing available -> providerId null + waitUntil', r.providerId === null && r.waitUntil === '2026-10-05T22:16:17Z', JSON.stringify(r));

  // 4. weekly exhausted (today's situation)
  router.clearCache();
  r = await router.route('GLM-5.3', { catalog, creds: [{ providerId: IND }], getQuota: async () => q(8000, 100, 0) });
  check('weekly exhausted -> null with the weekly reset as waitUntil', r.providerId === null && r.waitUntil === '2026-10-11T11:09:07Z', JSON.stringify(r));

  // 5. quota lookup failure is a skip, not a crash
  router.clearCache();
  r = await router.route('GLM-5.3-Flash', { catalog, creds: [{ providerId: IND }], getQuota: async () => { throw new Error('boom'); } });
  check('quota error -> candidate skipped with reason', r.providerId === null && /boom/.test(r.candidates.find((c) => c.providerId === IND).why));

  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
