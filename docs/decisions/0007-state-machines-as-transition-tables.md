---
status: proposed
---

# State machines are plain transition tables, not XState

Each entity with a life cycle declares a transition table in `packages/domain`: for each command, the states it may start from, the state it ends in, and an optional guard. States are a `Schema.TaggedUnion`. A transition is applied as `UPDATE … SET state = to WHERE id = $1 AND state = from` inside the command's transaction. The same table drives the runtime guard, the controls shown in the UI, the generated diagram and the property tests. This supersedes the 2026-10-16 brief revision that chose XState through `@xstate/effect`.

The machines are flat (two to six states), have no timers (time-based states such as "admission open" are calculated from dates), send side effects through the outbox, and keep no state in memory between requests. XState's strengths (nested and parallel states, delays, long-lived actors) are not used, and on 2026-10-26 `@xstate/effect` was `1.0.0-alpha.9` on `xstate` `6.0.0-alpha.70`.

## Considered options

- **XState via `@xstate/effect`.** Alpha, and an actor model for state that lives in a database row.
- **`@typeonce/effect-machine` 0.46, `effect-machine` 0.32, `@humanlayer/effect-machine` 0.20.** Effect v4 native, but built around long-lived actors and pre-1.0.

## Consequences

- Revisit when a machine needs nested or parallel states. A table can be translated into an XState definition then.

Source: `../../../../analysis/vektorprogrammet/INFORMATION_MODEL.md` §9.
