# Instructions for using the zcode-bridge MCP tools

You have access to a set of `zcode_*` tools. They connect you to a **ZCode agent harness running on this Windows machine** — a full autonomous coding agent with its own file, shell, and plugin tools, its own GLM model backend, and its own plan quota. Treat it as a capable local coworker you delegate real work to, not as a simple function call.

## The mental model

- **One `zcode_agent` call = one complete agent turn.** The ZCode agent plans, uses tools (reads/edits files, runs shell commands, searches), and returns its final answer. Simple replies take ~10–20 seconds; real tasks can take minutes. Tell the user when a call may take a while.
- The agent runs in a workspace directory (default `<repo>\bridge-workspace`, set in the bridge's `config.json`). It can navigate the whole machine — only point it at a workspace the user actually wants touched, via the optional `workspace` argument (absolute path).
- Results include the model that served the turn and token usage. Relay anything notable (e.g., which model, how many tokens).

## Tools and when to use them

**Delegating work**
- `zcode_agent` — one-shot task or question. Use for anything requiring real tool use on the machine: coding, file inspection/editing, running commands, multi-step work. Args: `prompt` (required), optional `workspace`, `reasoning_level` (low/high/max), `model` (per-call override).
- `zcode_session_start` → `zcode_session_send` → `zcode_session_status` / `zcode_session_stop` — use when the user wants an ongoing back-and-forth with the same agent session (shared context). Keep the returned `sessionId`; send follow-ups with it. Never send two turns to one session at once — sessions run one turn at a time.

**Long tasks — async turns (use these when a turn may run past ~10 minutes)**
- `zcode_agent`, `zcode_session_start`, `zcode_session_send` all accept `async: true`: they return immediately with `{sessionId, turnId, status:"running"}` instead of blocking for the whole turn.
- Then poll with `zcode_session_wait { session_id, timeout_s ≤ 600 }` — it blocks up to its timeout and returns `status` `running|done|error|cancelled` (with `finalText`, `lastOutput`, `usage`, `model`). Repeat until the status is no longer `running`.
- `zcode_session_output { session_id }` — a non-blocking peek at what the agent has streamed so far; use it to keep the user updated on progress.
- `zcode_session_cancel { session_id }` — cancel a running turn when the user asks to stop; the session stays usable afterwards.
- `zcode_sessions_list` — every session the bridge knows (in memory or on disk). If you ever lose a `sessionId` (e.g. a tool call timed out or an error interrupted you), find it here and resume polling with `zcode_session_wait`.

**Models**
- `zcode_models` — list available models (context windows, reasoning levels) with the current default marked.
- `zcode_model_set` — switch the default model for future sessions, or a live session's model with `session_id` (history is kept). Reversible.

**Plans and quota**
- `zcode_plans` — list every plan, which ones have credentials on this machine, and live token availability (5-hour and weekly windows: remaining, usage %, next reset) per plan. Use this to answer "do I have tokens left / which plan should I use".
- `zcode_plan_switch` — activate another credentialed plan (optionally pinning a `model`). Reversible; refuses cleanly if there are no local credentials for it.
- `zcode_plan_usage` — current plan's usage windows plus banked resets.

**Resets — handle with care**
- `zcode_plan_reset` (`type`: "five_hour" | "week") **consumes one banked reset on the user's plan account. This is real and irreversible.** Before calling it, always: (1) check `zcode_plan_usage` or `zcode_plans`, (2) state what will be consumed, and (3) get the user's explicit confirmation. Never call it speculatively or "just in case".
- `zcode_plan_reset_opportunity` — asks the backend to grant a new reset opportunity; harmless but rate-limited.

**Idle-time (off-peak) tasks — free but unattended**
- `zcode_offpeak_create { title, prompt, permission_mode?, model?, workspace?, session_id? }` — queue work that runs later **for free** during off-peak hours (0 plan-quota tokens). No guaranteed start time. The prompt must be fully self-contained and state the deliverable — nobody answers questions during the run. Prefer it for deferrable work the user explicitly wants done cheaply ("when it's free", "overnight", "don't burn quota").
- `zcode_offpeak_list` / `zcode_offpeak_status` — track tasks (live queue positions, sessionId once running).
- `zcode_offpeak_models` — the allowed idle models + whether a task can be created right now (and when the next slot frees up).
- `zcode_offpeak_cancel` / `_pause` / `_continue` / `_delete` — lifecycle actions; cancel keeps any files the run already modified.
- Constraints worth telling the user: coding-plan subscribers only; creations are rate-limited; the machine (and the bridge process) must stay awake for the run to happen; runs needing confirmation pause until someone looks. Check `zcode_offpeak_models` before the first create of a session.

## Rules of thumb

1. For chat-level questions, answer yourself — don't burn a harness turn.
2. For anything needing hands on the machine, delegate with `zcode_agent` and give it a self-contained prompt (it can't see this conversation).
3. First tool call after a quiet period takes ~10s extra (the harness is starting) — that's normal.
4. If a turn fails with "no models available" or auth errors, suggest the user open the ZCode desktop app once and retry.
5. Confirm before: consuming resets, pointing the agent at directories outside the default workspace, or running anything destructive-sounding the user requested loosely.
6. For tasks you expect to run long (big refactors, long test suites, anything the user calls "big"), start the turn with `async: true` and poll with `zcode_session_wait` — a blocking call that outlives your tool timeout loses the reply even though the turn keeps running.
7. When reporting agent results, include the essentials: what it did, its final answer, model used, and token usage if the user cares about quota.
