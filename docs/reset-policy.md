# Banked reset policy

A banked 5-hour reset only buys back the time until the window's **natural** reset. Spending one when
the natural reset is 20 minutes away wastes it. `lib/reset-policy.cjs` decides whether a reset is worth
it; the MCP server applies it.

## Tools

- `zcode_plan_reset_advise {queuedWork}`: dry run. Returns `spend`, `reasons`, `minutesSaved` (minutes
  until the natural reset, i.e. what a reset would buy), `fiveHourUsedPct`, `weeklyRemaining`,
  `weeklyRemainingPct`, `banked` and the resolved policy. Spends nothing.
- `zcode_plan_reset {type, queuedWork, force}`: for `type: "five_hour"` the policy runs first; when it says
  no, the call returns `{used: false, refusedByPolicy: true, advice}` and nothing is consumed.
  `force: true` skips both the availability pre-check and the policy. Week resets are not policy-gated.

## A reset is spent only when all of these hold

1. The policy is enabled.
2. More banked 5-hour resets exist than `keepBanked`.
3. The 5-hour window is at least `minFiveHourUsedPct` used.
4. The natural reset is at least `minMinutesToNaturalReset` minutes away (an idle window with no running
   clock is never reset).
5. The weekly window still has room: remaining > `minWeeklyRemaining` and remaining % >=
   `minWeeklyRemainingPct`. When the week is the binding limit, a 5-hour reset cannot help.
6. The caller reports queued or stalled work (`queuedWork: true`), unless `requireQueuedWork` is false.

The policy fails closed: if quota cannot be read, it says no.

## Settings (`config.json` → `resetPolicy`)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` = never spend automatically; manual `force` resets still work |
| `minFiveHourUsedPct` | `98` | 5-hour usage needed before a reset is considered |
| `minMinutesToNaturalReset` | `60` | wait instead when the natural reset is closer than this |
| `minWeeklyRemaining` | `0` | weekly credits that must remain |
| `minWeeklyRemainingPct` | `2` | weekly percentage that must remain |
| `requireQueuedWork` | `true` | only spend when the caller says work is waiting |
| `keepBanked` | `0` | never spend the last N banked resets |

Tests: `node test/reset-policy.cjs` (mocked snapshots, no network, nothing spent).
