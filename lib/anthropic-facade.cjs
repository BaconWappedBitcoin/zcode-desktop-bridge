'use strict';
/**
 * anthropic-facade.cjs — maps the Anthropic Messages API onto agent turns.
 *
 * Semantics: one POST /v1/messages = one full agent turn in a harness session
 * (the harness's own tools run; client-sent `tools` are accepted and ignored).
 * Conversation continuity via prefix hashing: clients always resend the full
 * history, so hash(all-but-last-message) identifies the session to continue;
 * on miss we create a session and import the prior history in claudeCode
 * format (native `importedHistory` support).
 */
const crypto = require('crypto');
const { flattenContent, flattenHistory, hashPrefix } = require('./agent-manager.cjs');

function newId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`; }

function mapUsage(tokens) {
  const t = tokens || {};
  const input = Math.max(0, (t.input || 0) - ((t.cache && t.cache.read) || 0));
  return {
    input_tokens: input,
    cache_creation_input_tokens: (t.cache && t.cache.write) || 0,
    cache_read_input_tokens: (t.cache && t.cache.read) || 0,
    output_tokens: t.output || 0,
    // informational extras (harness-reported)
    _reasoning_tokens: t.reasoning || 0,
    _total_tokens: t.total || 0,
  };
}

function messageResponse(model, result, opts = {}) {
  const content = [];
  if (opts.exposeThinking && result.reasoning) {
    content.push({ type: 'thinking', thinking: result.reasoning, signature: 'zcode-bridge' });
  }
  content.push({ type: 'text', text: result.text || '' });
  return {
    id: newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: result.finishReason === 'stop' ? 'end_turn' : (result.finishReason || 'end_turn'),
    stop_sequence: null,
    usage: mapUsage(result.usage),
  };
}

/** SSE event stream for one turn. Writes Anthropic-style events to `write`. */
async function streamResponse(write, model, runTurnPromise, opts = {}) {
  const msgId = newId('msg');
  const send = (obj) => write(`event: ${obj.event || 'unknown'}\ndata: ${JSON.stringify(obj.data)}\n\n`);
  const startedUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };

  send({ event: 'message_start', data: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: startedUsage } } });
  send({ event: 'ping', data: { type: 'ping' } });

  let blockIdx = 0;
  let textOpen = false;
  let thinkingOpen = false;
  const openBlock = (type) => {
    send({ event: 'content_block_start', data: { type: 'content_block_start', index: blockIdx, content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } } });
    if (type === 'thinking') thinkingOpen = true; else textOpen = true;
  };
  const closeBlock = () => {
    send({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIdx } });
    blockIdx += 1;
    thinkingOpen = false;
    textOpen = false;
  };

  try {
    const result = await runTurnPromise(async (delta) => {
      if (delta.type === 'reasoning') {
        if (!opts.exposeThinking) return;
        if (!thinkingOpen && textOpen) { closeBlock(); } // shouldn't happen, but stay ordered
        if (!thinkingOpen) openBlock('thinking');
        send({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIdx, delta: { type: 'thinking_delta', thinking: delta.text } } });
      } else {
        if (thinkingOpen && !textOpen) { closeBlock(); openBlock('text'); }
        if (!textOpen) openBlock('text');
        send({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: delta.text } } });
      }
    });
    if (thinkingOpen || textOpen) closeBlock();
    const usage = mapUsage(result.usage);
    send({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: result.finishReason === 'stop' ? 'end_turn' : (result.finishReason || 'end_turn'), stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, output_tokens: usage.output_tokens },
      },
    });
    send({ event: 'message_stop', data: { type: 'message_stop' } });
    return { id: msgId, usage, result };
  } catch (e) {
    if (thinkingOpen || textOpen) closeBlock();
    send({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: e.message || 'turn failed' } } });
    send({ event: 'message_stop', data: { type: 'message_stop' } });
    throw e;
  }
}

// ---------------------------------------------------------------- validation
function validateMessagesBody(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages: required and must be a non-empty array';
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return 'messages: entries must be objects';
    if (m.role !== 'user' && m.role !== 'assistant') return `messages: invalid role ${JSON.stringify(m.role)}`;
    const c = m.content;
    if (typeof c !== 'string' && !Array.isArray(c)) return 'messages: content must be string or array of blocks';
  }
  const last = body.messages[body.messages.length - 1];
  if (last.role !== 'user') return 'messages: the final message must have role "user" for a new agent turn';
  const finalText = flattenContent(last.content);
  if (!finalText.trim()) return 'messages: the final user message has no usable text content';
  return null;
}

/** Extract (system, priorMessages, finalText) with prefix-hash keys. */
function decomposeRequest(body) {
  const system = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system) ? body.system.map((b) => (b && b.text) || '').join('\n') : '';
  const messages = body.messages;
  const prior = messages.slice(0, -1);
  const finalText = flattenContent(messages[messages.length - 1].content);
  return {
    system,
    prior,
    finalText,
    prevKey: hashPrefix(system, prior),
    fullKey: hashPrefix(system, messages),
  };
}

/** Build importedHistory payload (claudeCode source) from prior messages. */
function buildImportedHistory(system, prior, title) {
  const flat = flattenHistory(prior);
  if (!flat.length) return null;
  if (system) flat.unshift({ role: 'user', content: `[system instructions]\n${system}`, timestamp: Date.now() });
  return { source: 'claudeCode', title: String(title || 'anthropic-bridge conversation').slice(0, 80), messages: flat };
}

function anthropicError(res, status, type, message) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

module.exports = {
  mapUsage, messageResponse, streamResponse,
  validateMessagesBody, decomposeRequest, buildImportedHistory,
  anthropicError, newId,
};
