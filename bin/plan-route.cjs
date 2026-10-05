#!/usr/bin/env node
'use strict';
/** bin/plan-route.cjs <modelId> [--json] — print the providerId that currently has
 *  credit for the model (lane launchers read it); exit 2 with a JSON reason on
 *  stderr when no plan has credit (includes waitUntil). */
const path = require('path');
const fs = require('fs');
const router = require('../lib/plan-router.cjs');

(async () => {
  const args = process.argv.slice(2);
  const model = args.find((a) => !a.startsWith('--'));
  if (!model) { console.error('usage: plan-route.cjs <modelId> [--json]'); process.exit(64); }
  let policy = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    policy = cfg.planRouter || {};
  } catch { /* defaults */ }
  const r = await router.route(model, { policy });
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.providerId ? 0 : 2); }
  if (r.providerId) { console.log(r.providerId); process.exit(0); }
  console.error(JSON.stringify({ error: r.reason, waitUntil: r.waitUntil, candidates: r.candidates }));
  process.exit(2);
})().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(2); });
