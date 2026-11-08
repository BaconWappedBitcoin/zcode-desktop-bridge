'use strict';
/**
 * mock-llm.cjs — a scripted OpenAI-compatible chat-completions server for live tests against the real
 * ZCode app-server without a real model: no credits, no GPU, deterministic.
 *
 * Script, per request:
 *  - the latest user message contains "MOCK:TOOL:<seconds>" and no tool result follows it → stream one
 *    Bash tool call running `ping -n <seconds+1> 127.0.0.1` (a tool step that takes <seconds>);
 *  - otherwise → stream the text "REPLY to: <latest user text>", plus " (after tool)" when a tool result is
 *    the newest message. A steer delivered mid-turn shows up as the latest user text of the request after
 *    the tool step; a queued message as the latest user text of its own turn.
 * Every request is recorded in `requests` ({at, roles, lastUser, afterTool, reply}).
 *
 * providerConfig(url) builds a ZCode personal provider config (ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) that
 * offers this server as model MOCK_MODEL of provider MOCK_PROVIDER.
 */
const http = require('http');

const MOCK_PROVIDER = '7e5f0b1a-3c2d-4e6f-8a9b-0c1d2e3f4a5b';
const MOCK_MODEL = 'mock-model';

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && (p.text || p.content)) || '').join('\n');
  return '';
};

function bashTool(tools) {
  const fns = (tools || []).map((t) => t && t.function).filter(Boolean);
  return fns.find((f) => /^bash$/i.test(f.name)) || fns.find((f) => /bash|shell|powershell/i.test(f.name)) || null;
}

function toolArgs(fn, command) {
  const props = (fn.parameters && fn.parameters.properties) || {};
  const args = { command };
  if (props.description) args.description = 'mock tool step';
  return args;
}

function createMockLlm({ log = () => {} } = {}) {
  const requests = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
        return;
      }
      if (!/\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      let json = {};
      try { json = JSON.parse(body); } catch { /* empty */ }
      const messages = json.messages || [];
      let lastUserIdx = -1;
      let lastToolIdx = -1;
      messages.forEach((m, i) => {
        if (m.role === 'user') lastUserIdx = i;
        if (m.role === 'tool') lastToolIdx = i;
      });
      const lastUser = lastUserIdx >= 0 ? textOf(messages[lastUserIdx].content) : '';
      const toolMatch = /MOCK:TOOL:(\d+)/.exec(lastUser);
      const fn = bashTool(json.tools);
      const id = `chatcmpl-mock-${++seq}`;
      const created = Math.floor(Date.now() / 1000);
      const entry = {
        at: Date.now(),
        roles: messages.map((m) => m.role),
        lastUser,
        // every user/assistant text the model was given, in order: what history it saw
        history: messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => `${m.role}: ${textOf(m.content)}`),
        afterTool: lastToolIdx > lastUserIdx,
        stream: json.stream !== false,
      };
      let reply;
      if (toolMatch && lastToolIdx < lastUserIdx && fn) {
        const seconds = Number(toolMatch[1]);
        reply = { tool: fn.name, args: toolArgs(fn, `ping -n ${seconds + 1} 127.0.0.1`) };
      } else {
        reply = { text: `REPLY to: ${lastUser.replace(/\s+/g, ' ').trim().slice(0, 200)}${entry.afterTool ? ' (after tool)' : ''}` };
      }
      entry.reply = reply;
      requests.push(entry);
      log('mock request', entry);
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      if (json.stream === false) {
        const message = reply.text
          ? { role: 'assistant', content: reply.text }
          : { role: 'assistant', content: null, tool_calls: [{ id: `call_${seq}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', created, model: MOCK_MODEL, choices: [{ index: 0, message, finish_reason: reply.text ? 'stop' : 'tool_calls' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify(Object.assign({ id, object: 'chat.completion.chunk', created, model: MOCK_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] }, extra))}\n\n`);
      chunk({ role: 'assistant', content: '' });
      if (reply.text) {
        for (const piece of reply.text.match(/.{1,24}/gs) || []) chunk({ content: piece });
        chunk({}, 'stop');
      } else {
        chunk({ tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: reply.tool, arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] });
        chunk({}, 'tool_calls');
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MOCK_MODEL, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function providerConfig(url) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: MOCK_PROVIDER,
          providerName: 'Mock',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'mock-key' },
            api: { type: 'openai-chat-completions', baseUrl: url },
            personalModelIds: [MOCK_MODEL],
            modelOrder: [MOCK_MODEL],
          },
        }],
      },
      modelConfigRules: {
        providerModelRules: [{ modelId: MOCK_MODEL, providerId: MOCK_PROVIDER, config: { properties: { contextWindow: 131072 } } }],
        manualProviderModelRules: [],
      },
    },
  };
}

module.exports = { createMockLlm, providerConfig, MOCK_PROVIDER, MOCK_MODEL };
