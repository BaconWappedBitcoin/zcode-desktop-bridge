# zcode desktop bridge

Expose the **ZCode desktop harness** (Windows) through standard interfaces, so any client can drive the full agent — with the desktop app's machinery, and the desktop-only plan perks the CLI never gets:

## Why?

On a credit-metered coding plan, **the quota window is the real cost** — everything this bridge does exists to spend it better and to never let an empty window stop your work:

- **Prompt-cache-friendly continuity.** The harness injects a ~40k-token system prompt into every turn. By continuing the *same* session across requests (prefix-hash matching), follow-ups hit the provider's prompt cache — in testing, a second turn reported ~40.6k of 40.7k input tokens as cache reads. Cached input is the difference between a follow-up costing nearly nothing and paying full freight every message.
- **The right model for each task.** Switch models per call, per session, or as the default (`zcode_model_set`, `zcode_agent`'s `model` argument) — cheap GLM-5.3-Flash for lookups and small edits, full GLM-5.3 when the task deserves it, decided per request instead of per login.
- **Know before you spend.** `zcode_plans` / `zcode_plan_usage` show the live 5-hour and weekly windows (remaining, usage %, next reset), so a client can check the budget before starting a big job — and switch to whichever plan still has tokens (`zcode_plan_switch`).
- **Resets without the desktop UI.** Banked 5-hour/weekly resets are a desktop-only feature — the CLI gets none of them. Through the bridge, a client can see them, request new opportunities, and **spend one mid-run when a window empties** (`zcode_plan_reset`), so a long job doesn't stall just because nobody is watching the quota meter. Resets effectively multiply your usable quota; making them scriptable turns them into capacity you control.
- **One turn, many steps.** Each call is a full agent turn with its own tools — work that would take dozens of raw model round-trips (each metered) becomes one tool-using turn against a cached context.

All of it runs on the *desktop's* machinery — same app-server protocol, same sessions, same auth, same quota system. Not the CLI.


- **An Anthropic-compatible Messages API** (`POST /v1/messages`, streaming + non-streaming) — chat UIs, Claude Code, LangChain, or any Anthropic-protocol client can use the ZCode agent as if it were a Claude model.
- **An MCP server** (stdio) — Claude Code, Claude Desktop, Cline, Cursor, or another ZCode instance can run harness sessions as tools, list/switch models, inspect plan token availability, and spend banked quota resets.

```
Anthropic-protocol clients        MCP clients (Claude Code/Desktop,
        │                          Cline, Cursor, ZCode itself, …)
        │ HTTP/SSE (server.cjs)    │ stdio JSON-RPC (mcp-server.cjs)
        └──────────┬───────────────┘
                   ▼
        lib/agent-manager.cjs   sessions, turns, streaming, history import
        lib/zcode-protocol.cjs  ZCode Protocol client (NDJSON over stdio)
                   │  spawns its own app-server, exactly like the desktop host:
                   │  ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs app-server --stdio
                   ▼
        ZCode agent sessions — full harness toolset (files, shell, MCP plugins),
        your configured model + coding-plan auth, sessions visible in the
        desktop app's session list
```

## Requirements

- Windows with the **ZCode desktop app installed**, signed in at least once (credentials in `~/.zcode/v2/credentials.json` are the bridge's auth).
- Node.js ≥ 18 *or* nothing at all — `run-bridge.cmd` runs the server on the harness's embedded Node.

## Quickstart

```bash
# Anthropic facade on http://127.0.0.1:8787 (system Node):
node server.cjs
# … or with no Node installed (uses ZCode.exe as Node):
run-bridge.cmd

curl http://127.0.0.1:8787/v1/messages -H 'content-type: application/json' -d '{
  "model": "claude-sonnet-4-5", "max_tokens": 1024, "stream": true,
  "messages": [{"role": "user", "content": "Read the README in this workspace and summarize it."}]
}'
```

Point any Anthropic client at it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.

**Mount the MCP server** (Claude Code):

```bash
claude mcp add --scope user zcode-bridge -- node "<repo>\mcp-server.cjs"
# self-contained variant (harness's own Node, no Node install needed):
claude mcp add --scope user zcode-bridge --env ELECTRON_RUN_AS_NODE=1 -- \
  "C:\Users\<you>\AppData\Local\Programs\ZCode\ZCode.exe" "<repo>\mcp-server.cjs"
```

Claude Desktop: add to `%APPDATA%\Claude\claude_desktop_config.json`, then restart it:

```json
{ "mcpServers": { "zcode-bridge": {
    "command": "node", "args": ["<repo>\\mcp-server.cjs"] } } }
```

A ready-made system prompt for Claude lives in [`CLAUDE-DESKTOP-PROMPT.md`](CLAUDE-DESKTOP-PROMPT.md).

## Tools (MCP)

| tool | what it does |
|---|---|
| `zcode_agent` | one-shot agent turn (full tool access), progress notifications, per-call model override |
| `zcode_session_start` / `send` / `status` / `stop` | persistent multi-turn sessions |
| `zcode_models` / `zcode_model_set` | list catalog; switch default or live-session model (mid-conversation, history kept) |
| `zcode_plans` | every plan, which have local credentials, **live token availability** per window |
| `zcode_plan_switch` | activate another credentialed plan (entitlement push + validation + default model) |
| `zcode_plan_usage` | current 5-hour/weekly windows + banked resets |
| `zcode_plan_reset` | **consume one banked reset** (irreversible; refuses when nothing is banked) |
| `zcode_plan_reset_opportunity` | request a new reset opportunity from the backend |

## Semantics you should know

- **One request = one full agent turn.** The harness agent runs to completion (its own tools, its own judgment); the final answer becomes the assistant message. Trivial replies ~10–20 s; real tasks take as long as they take. First call after idle adds ~10 s of harness startup.
- **Client-sent `tools` are accepted and ignored** — the harness's own toolset runs instead; that's the point. `tool_choice`/`temperature`/`top_p`/`max_tokens`/`stop_sequences` likewise.
- **Conversation continuity is real**: clients that resend full history (all Anthropic clients) hit a prefix-hash cache that continues the *same* harness session (prompt-cache friendly); on miss, prior history imports into a new session via native `importedHistory`. Retrying an identical completed request forks a new conversation.
- **Streaming** is standard Anthropic SSE, diffed from the harness message store at ~500 ms granularity — sub-second, not token-level.
- **Usage** maps to Anthropic fields; harness prompt-cache hits surface as `cache_read_input_tokens`.
- **The desktop app does not need to stay open.** The bridge spawns its own app-server and resolves auth itself. Do open it occasionally — it refreshes the JWTs the plan-quota tools use, and it's where reward-earned resets appear.
- Bridge-scoped switches (model/plan defaults) never rewrite the desktop's own config.

## Configuration

Copy `config.example.json` → `config.json`:

| key | default | meaning |
|---|---|---|
| `port` / `bind` | `8787` / `127.0.0.1` | HTTP listen address (env `PORT`/`BIND`) |
| `apiKey` | *(none)* | require matching `x-api-key`/Bearer (env `ZCODE_BRIDGE_API_KEY`) |
| `workspacePath` | `<repo>/bridge-workspace` | where agent sessions run |
| `mode` | `yolo` | harness permission mode (auto-approve the agent's own tool use) |
| `modelAliases` | *(map)* | map request model names → harness selections; unknown models use the harness default |
| `exposeThinking` | `false` | stream harness reasoning as `thinking` blocks |
| `includeToolActivity` | `false` | log internal tool activity |
| `turnTimeoutMs` / `sessionIdleMs` | `900000` / `1800000` | turn cap; idle-session reaping |

Env overrides: `ZCODE_EXE`, `ZCODE_BUNDLE`, `ZCODE_DIR`, `ZCODE_HOME`, `ZCODE_BUILTIN_FILE`, `ZCODE_CREDENTIAL_SECRET`, `ZCODE_PLAN_ORIGIN`, `ZCODE_QUOTA_ORIGIN`.

## How it talks to the harness

Verified against ZCode desktop 3.14.4 / agent 0.16.9 (see `proto-probe.cjs`, the instrumented explorer):

- The desktop host runs one **ZCode Protocol app-server** per workspace — `ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs app-server --stdio`, newline-delimited JSON-RPC, no handshake. Sessions: `session/create` → `session/setModel` (needs an explicit `options.reasoningLevel`) → `session/subscribe {deliveryKind:"desktop-continuous"}` → `session/send`. Completion = `v4/telemetry {kind:"turn.terminal"}`; final text lives in `session/messages` parts (`text`, `reasoning`, `step-finish` with usage).
- Worker app-servers start with account providers **unentitled**. The bridge replays the desktop host's `provider/updateAccountConfig` push; the registry CAS-checks `basedOnZCodeBuiltinRevision` against `zcode-builtin:<revision>:<sha256(active file path)>`, computed from the runtime-cached registry. A session's model list freezes at creation, so entitlement is verified with a session created *after* the push.
- Model calls trigger a server→client `interaction/requestProviderRuntimeHeaders` request; the bridge answers with the coding-plan API key decrypted from `~/.zcode/v2/credentials.json` (`enc:v1:` = AES-256-GCM with a machine-derivable secret — the same scheme the CLI uses). Keys never leave the process except to the app-server over its private stdio pipe, and are never logged.
- Plan quota/resets use the desktop's own backend calls: `GET api.z.ai/api/monitor/usage/quota/limit` (plan API key; unit 3 = 5-hour window, unit 6 = weekly) and `zcode.z.ai/api/v1/coding-plan/reset/{status,use,opportunity}` (zcode JWT + MaaS token headers; `reset_type` is `"FIVE_HOUR" | "WEEK"`, idempotency keys must be UUIDs).

## Security notes

- Binds to `127.0.0.1`; set an `apiKey` before exposing further. The MCP stdio surface has no auth (local process, like any MCP server).
- The agent can run anywhere on the machine — treat the endpoint with the trust you'd give the desktop app.
- `config.json` holds no secrets; everything sensitive is decrypted at runtime from the harness's own store. `out/`, `bridge-workspace/`, and `config.json` are git-ignored.

## Testing

```bash
bash test/e2e.sh          # facade: health, stream/non-stream, continuity, validation (18 checks)
node test/mcp-smoke.cjs   # MCP: handshake, agent turn, model switch cycle, plans, quota
```

## Project layout

```
server.cjs                Anthropic Messages facade (HTTP/SSE)
mcp-server.cjs            MCP stdio front-end (12 tools)
lib/harness-env.cjs       install discovery, config reads, credential decryption
lib/zcode-protocol.cjs    ZCode Protocol client + desktop-host request responders
lib/agent-manager.cjs     sessions, turns, streaming, history import, model/plan switching
lib/coding-plan.cjs       plan quota windows + banked resets (Z.ai backend)
run-bridge.cmd            launcher on the harness's embedded Node
CLAUDE-DESKTOP-PROMPT.md  ready-made system prompt for Claude clients
test/                     e2e + MCP smoke suites
proto-probe.cjs           protocol exploration harness (dev tool)
```

## Status & disclaimer

Unofficial, not affiliated with Z.ai or the ZCode team. The wire protocol and backend endpoints above are reverse-engineered from the installed desktop app and may change between versions — if something breaks after a ZCode update, re-run `proto-probe.cjs` and `node test/mcp-smoke.cjs` to see what moved.
