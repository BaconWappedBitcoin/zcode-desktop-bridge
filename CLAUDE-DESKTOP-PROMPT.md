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

## Rules of thumb

1. For chat-level questions, answer yourself — don't burn a harness turn.
2. For anything needing hands on the machine, delegate with `zcode_agent` and give it a self-contained prompt (it can't see this conversation).
3. First tool call after a quiet period takes ~10s extra (the harness is starting) — that's normal.
4. If a turn fails with "no models available" or auth errors, suggest the user open the ZCode desktop app once and retry.
5. Confirm before: consuming resets, pointing the agent at directories outside the default workspace, or running anything destructive-sounding the user requested loosely.
6. When reporting agent results, include the essentials: what it did, its final answer, model used, and token usage if the user cares about quota.
