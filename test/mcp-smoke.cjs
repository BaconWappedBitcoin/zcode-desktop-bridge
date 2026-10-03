#!/usr/bin/env node
'use strict';
/** test/mcp-smoke.cjs — raw stdio MCP client exercising the bridge server. */
const { spawn } = require('child_process');

const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'mcp-server.cjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.stdout.setEncoding('utf8');

let nextId = 1;
const pending = new Map();
let notifications = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } else {
      notifications.push(msg);
    }
  }
});

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log('T+0ms initialize:', JSON.stringify(init.result.serverInfo), 'proto', init.result.protocolVersion);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await call('tools/list');
  console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

  const r = await call('tools/call', {
    name: 'zcode_agent',
    arguments: { prompt: 'Reply with exactly MCP_SMOKE_OK and nothing else. Do not use tools.', reasoning_level: 'low' },
    _meta: { progressToken: 'tok-1' },
  });
  const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
  console.log('T+' + (Date.now() - t0) + 'ms zcode_agent =>', JSON.stringify(text).slice(0, 400));
  console.log('progress notifications:', notifications.filter((n) => n.method === 'notifications/progress').length);

  const models = await call('tools/call', { name: 'zcode_models', arguments: {} });
  const mtext = models.result && models.result.content && models.result.content[0].text;
  console.log('models =>', mtext && mtext.slice(0, 300).replace(/\n/g, ' '));

  const plan = await call('tools/call', { name: 'zcode_plan_usage', arguments: {} });
  const ptext = plan.result && plan.result.content && plan.result.content[0].text;
  console.log('plan usage =>', ptext && ptext.slice(0, 500).replace(/\n/g, ' '));
  const planOk = /five_hour/.test(String(ptext)) && /week/.test(String(ptext));
  console.log(planOk ? 'PLAN READ OK' : 'PLAN READ FAIL');

  // model switch cycle: default -> GLM-5.3 -> verify -> agent turn on it -> back
  const set1 = await call('tools/call', { name: 'zcode_model_set', arguments: { model: 'GLM-5.3', reasoning_level: 'low' } });
  const s1 = JSON.stringify(set1.result && set1.result.structuredContent || {});
  console.log('model_set =>', (set1.result && set1.result.content && set1.result.content[0].text || '').slice(0, 150));
  const modelsAfter = await call('tools/call', { name: 'zcode_models', arguments: {} });
  const ma = modelsAfter.result && modelsAfter.result.structuredContent;
  const defaultIs53 = ma && ma.default && ma.default.modelId === 'GLM-5.3';
  console.log('default after switch:', ma && ma.default && `${ma.default.providerId}/${ma.default.modelId}`);
  const agent53 = await call('tools/call', { name: 'zcode_agent', arguments: { prompt: 'Reply with exactly MODEL_SWITCH_OK and nothing else. Do not use tools.' } });
  const a53 = agent53.result && agent53.result.structuredContent;
  console.log('agent on switched model =>', a53 && a53.model && `${a53.model.providerId}/${a53.model.modelId}`, '| text:', a53 && JSON.stringify(a53.text).slice(0, 60));
  const restore = await call('tools/call', { name: 'zcode_model_set', arguments: { model: 'GLM-5.3-Flash' } });
  console.log('restored =>', restore.result && restore.result.content && restore.result.content[0].text);
  const switchOk = defaultIs53 && a53 && a53.model && a53.model.modelId === 'GLM-5.3' && /MODEL_SWITCH_OK/.test(String(a53 && a53.text));

  // plans: list, refuse-without-credentials, idempotent re-switch of active plan
  const plans = await call('tools/call', { name: 'zcode_plans', arguments: {} });
  const pl = plans.result && plans.result.structuredContent;
  const credPlans = (pl && pl.plans || []).filter((p) => p.hasLocalCredentials);
  console.log('plans =>', (pl && pl.plans || []).length, 'known,', credPlans.length, 'with credentials; active:', pl && pl.activeProviderId);
  if (credPlans[0]) console.log('cred plan quota windows:', JSON.stringify(credPlans[0].tokensAvailable).slice(0, 300));
  const badSwitch = await call('tools/call', { name: 'zcode_plan_switch', arguments: { plan: 'account:zai-team-coding-plan' } });
  const badMsg = badSwitch.result && badSwitch.result.content && badSwitch.result.content[0].text || '';
  const badOk = badSwitch.result && badSwitch.result.isError === true && /no local credentials/.test(badMsg);
  console.log('switch w/o credentials =>', badOk ? 'cleanly refused' : `UNEXPECTED: ${badMsg.slice(0, 150)}`);
  let reSwitchOk = true;
  if (credPlans[0]) {
    const re = await call('tools/call', { name: 'zcode_plan_switch', arguments: { plan: credPlans[0].providerId } });
    const reTxt = re.result && re.result.content && re.result.content[0].text || '';
    reSwitchOk = !re.result.isError && /active plan is now/.test(reTxt);
    console.log('re-switch active plan =>', reTxt.slice(0, 150));
  }
  const plansOk = !!pl && pl.plans.length >= 1 && credPlans.length >= 1 && badOk && reSwitchOk;

  const ok = /MCP_SMOKE_OK/.test(String(text)) && planOk && switchOk && plansOk;
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  child.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); child.kill(); process.exit(1); });
