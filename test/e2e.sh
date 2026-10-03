#!/usr/bin/env bash
# test/e2e.sh — end-to-end suite for the Anthropic facade.
# Starts a private bridge instance on a test port, exercises the API, kills it.
# Usage: bash test/e2e.sh [port]     (requires curl + node on PATH)
set -u
PORT="${1:-8799}"
BASE="http://127.0.0.1:${PORT}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/out/e2e-server.log"
mkdir -p "$DIR/out"

PASS=0; FAIL=0
check() { # name expected_substring actual
  if [[ "$3" == *"$2"* ]]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1 — expected substring '$2' in: ${3:0:300}"; FAIL=$((FAIL+1)); fi
}

echo "== starting bridge on :$PORT =="
PORT=$PORT node "$DIR/server.cjs" >"$LOG" 2>&1 &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null' EXIT

for i in $(seq 1 20); do
  curl -s "$BASE/healthz" | grep -q '"ok":true' && break
  sleep 1
done
echo "== 1. healthz =="
R=$(curl -s "$BASE/healthz")
check "healthz reports ok" '"ok":true' "$R"

echo "== 2. non-streaming turn =="
R=$(curl -s --max-time 240 -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"Reply with exactly E2E_TOKEN_A and nothing else. Do not use tools."}]}')
check "non-stream returns E2E_TOKEN_A" 'E2E_TOKEN_A' "$R"
check "non-stream has anthropic shape" '"type":"message"' "$R"
check "non-stream has usage" '"input_tokens"' "$R"

echo "== 3. streaming turn =="
R=$(curl -sN --max-time 240 -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"Reply with exactly E2E_TOKEN_B and nothing else. Do not use tools."}]}')
check "stream has message_start" 'event: message_start' "$R"
check "stream has text_delta" 'text_delta' "$R"
check "stream has message_stop" 'event: message_stop' "$R"
check "stream carries E2E_TOKEN_B" 'E2E_TOKEN_B' "$R"

echo "== 4. multi-turn continuity (session reuse) =="
R=$(curl -s --max-time 240 -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"My codename is E2E_FALCON. Remember it."}]}')
check "turn 4a acknowledges" '"role":"assistant"' "$R"
R=$(curl -s --max-time 240 -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"My codename is E2E_FALCON. Remember it."},{"role":"assistant","content":"Understood."},{"role":"user","content":"What is my codename? Codename only."}]}')
check "turn 4b recalls codename" 'E2E_FALCON' "$R"
R=$(curl -s --max-time 240 -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"My codename is E2E_FALCON. Remember it."},{"role":"assistant","content":"Understood."},{"role":"user","content":"What is my codename? Codename only."},{"role":"assistant","content":"E2E_FALCON"},{"role":"user","content":"Say DONE to close."}]}')
check "turn 4c continues" 'DONE' "$R"
if grep -q "conversation continued" "$LOG"; then echo "  PASS  continuity reused a session (see log)"; PASS=$((PASS+1));
else echo "  WARN  no 'conversation continued' in log (continuity may have re-imported)"; fi

echo "== 5. validation and misc endpoints =="
R=$(curl -s -X POST "$BASE/v1/messages" -H 'content-type: application/json' -d '{"model":"x","messages":[]}')
check "empty messages rejected" 'invalid_request_error' "$R"
R=$(curl -s -X POST "$BASE/v1/messages" -H 'content-type: application/json' -d 'not json')
check "bad json rejected" 'invalid_request_error' "$R"
R=$(curl -s -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"x","messages":[{"role":"assistant","content":"hi"}]}')
check "assistant-last rejected" 'invalid_request_error' "$R"
R=$(curl -s "$BASE/v1/models")
check "models endpoint" 'zcode-agent' "$R"
R=$(curl -s -X POST "$BASE/v1/messages/count_tokens" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello world"}]}')
check "count_tokens returns a number" 'input_tokens' "$R"
R=$(curl -s "$BASE/nope")
check "404 shape" 'not_found_error' "$R"

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
