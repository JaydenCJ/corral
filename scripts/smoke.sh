#!/usr/bin/env bash
# Corral smoke test: boots `corral serve` with the deterministic MockBackend on
# loopback and asserts the OpenAI-compatible surface end to end — health, a
# valid chat completion, and a hot-swap to a second model. No network access is
# used beyond the 127.0.0.1 server this script starts itself, and no model
# weights are downloaded. Prints "SMOKE OK" and exits 0 only if every assertion
# passes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CORRAL_HOME="$(mktemp -d)"
export CORRAL_HOME
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$CORRAL_HOME"
}
trap cleanup EXIT

fail() {
  echo "[smoke] FAIL: $*" >&2
  exit 1
}

# 1. Build if the CLI is not compiled yet (idempotent).
if [ ! -f "dist/cli.js" ]; then
  echo "[smoke] building..."
  npm run build >/dev/null 2>&1 || fail "build failed"
fi

# 2. Pick a free loopback port without external tools.
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
BASE="http://127.0.0.1:${PORT}"
echo "[smoke] starting corral serve on ${BASE} (backend: mock)"

# 3. Start the server with a single-model residency so the hot-swap evicts.
node dist/cli.js serve --backend mock --host 127.0.0.1 --port "$PORT" \
  --max-loaded 1 --idle-timeout 600000 >"$CORRAL_HOME/serve.log" 2>&1 &
SERVER_PID=$!

# 4. Wait for readiness.
READY=""
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null || echo 000)" = "200" ]; then
    READY=1
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited early (see log below)$(printf '\n'; cat "$CORRAL_HOME/serve.log")"
  sleep 0.25
done
[ -n "$READY" ] || fail "server did not become healthy in time"

# 5. /health returns 200.
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")"
[ "$CODE" = "200" ] || fail "GET /health returned $CODE, expected 200"
echo "[smoke] GET /health -> 200"

# 6. Chat completion has a valid OpenAI shape for model smoke-a.
RESP_A="$(curl -s "${BASE}/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"smoke-a","messages":[{"role":"user","content":"hello"}]}')"
echo "$RESP_A" | grep -q '"object":"chat.completion"' || fail "chat response missing object=chat.completion: $RESP_A"
echo "$RESP_A" | grep -q '"model":"smoke-a"' || fail "chat response wrong model: $RESP_A"
echo "$RESP_A" | grep -q '\[smoke-a\] echo: hello' || fail "chat response wrong content: $RESP_A"
echo "[smoke] POST /v1/chat/completions (smoke-a) -> valid OpenAI shape"

# 7. Hot-swap to a second model; with max-loaded=1 the first is LRU-evicted.
RESP_B="$(curl -s "${BASE}/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"smoke-b","messages":[{"role":"user","content":"world"}]}')"
echo "$RESP_B" | grep -q '"model":"smoke-b"' || fail "hot-swap response wrong model: $RESP_B"
echo "$RESP_B" | grep -q '\[smoke-b\] echo: world' || fail "hot-swap response wrong content: $RESP_B"
echo "[smoke] POST /v1/chat/completions (smoke-b) -> hot-swap succeeded"

PS="$(curl -s "${BASE}/api/ps")"
echo "$PS" | grep -q '"id":"smoke-b"' || fail "ps missing smoke-b: $PS"
echo "$PS" | grep -q '"id":"smoke-a"' && fail "smoke-a should have been LRU-evicted: $PS"
echo "[smoke] GET /api/ps -> only smoke-b resident (smoke-a evicted)"

# 7b. /v1/models agrees with what the server is actually serving: the loaded
# mock model is listed (non-empty data[]), the evicted one is not.
MODELS="$(curl -s "${BASE}/v1/models")"
echo "$MODELS" | grep -q '"object":"list"' || fail "models response is not a list: $MODELS"
echo "$MODELS" | grep -q '"id":"smoke-b"' || fail "/v1/models missing loaded model smoke-b: $MODELS"
echo "$MODELS" | grep -q '"id":"smoke-a"' && fail "/v1/models should not list evicted smoke-a: $MODELS"
echo "[smoke] GET /v1/models -> lists loaded mock model smoke-b"

# 8. Streaming passthrough delivers multiple SSE chunks ending in [DONE].
STREAM="$(curl -s -N "${BASE}/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"smoke-b","messages":[{"role":"user","content":"stream"}],"stream":true}')"
echo "$STREAM" | grep -q 'chat.completion.chunk' || fail "stream missing chunk objects"
echo "$STREAM" | grep -q 'data: \[DONE\]' || fail "stream missing [DONE] terminator"
echo "[smoke] POST /v1/chat/completions (stream) -> SSE chunks + [DONE]"

echo "SMOKE OK"
