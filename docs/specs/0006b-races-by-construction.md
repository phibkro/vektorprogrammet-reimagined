# Spec 0006b: races avoided by construction

Status: frozen 2026-10-27. Operator decision: "try avoiding races by construction". Stacked on PR #12 (`chore/effect-4.0.6-drizzle-rc5`).

## Problem

Spec 0006 R6 fixed a deadlock by hand: `MembershipRepository.insert` and `setEnd` now lock the person's row before writing, so two overlapping writes of one person queue instead of deadlocking (SQLSTATE 40P01, about 0.6% of contended rounds). Two facts keep that fix fragile:

1. **The lock is a convention.** Nothing stops the next write to a person's rows (accounts and codes in spec 0007, consents in 0007b, placements in 0011, claims in 0012) from skipping it, and a single-attempt test does not notice.
2. **State transitions are hand-written.** Each repository writes its own `UPDATE … WHERE state = from`. A new repository method can update the state column without that condition and lose an update silently.

## Race classes and the construct that removes each

| Race | Construct (this spec) | Already in place |
| --- | --- | --- |
| Two writes that must not coexist (overlap, duplicate) | — | constraints (unique, check, exclusion) |
| Deadlock between constrained writes on one aggregate | **aggregate lock token** (1) | hand-placed row lock in two methods |
| Deadlock between two aggregates locked in different orders (merge, cross-department change) | **ordered multi-lock** (2) | — |
| Decision on a fact read outside the lock (check-then-act) | **decisions read through the token** (3) | — |
| Lost update on a state machine | **machine-applied transitions** (4) | conditional updates, by hand |
| Side effect done twice, or done without the commit | — | outbox after commit, unique claims |

## Contract

1. **Aggregate lock token.** An aggregate root is declared in `packages/db` with the tables it owns (`Person` owns `membership`, `admin_grant`, and from spec 0007 `account`, `code`; later specs add their tables to the declaration). `Aggregate.lock(Person, id)` requires `InTransaction`, runs `SELECT … FOR NO KEY UPDATE` on the root row, and returns `Locked<Person>` for that id. Every write (insert, update, delete) to an owned table takes a `Locked<Root>` for the row's owner; a write without it does not type-check. The token cannot be constructed outside `Aggregate.lock` (an unexported brand) and does not outlive the transaction that made it.
2. **Ordered multi-lock.** `Aggregate.lockAll(Person, ids)` locks several roots of one type in ascending id order in one statement order; a command that needs two aggregates (`mergePersons`, a cross-department `change`) uses it. Locking two different root types follows one declared global order (the declaration lists roots in order). A second `lock` call for a root already held in the same transaction returns the held token.
3. **Decisions read through the token.** A read whose result decides a write (current memberships for an overlap check, the last active admin, the account state) is a method that takes `Locked<Root>`, so it runs after the lock and inside the transaction. Reads for display stay unlocked and keep passing the SELECT-only role test.
4. **Machine-applied transitions.** A machine's stored state column is written only by `Machine.apply(machine, transition, locked, row)`, which generates `UPDATE … SET state = to WHERE id = $1 AND state = ANY(from)` and returns `Conflict` on zero rows. Repositories no longer write state columns directly. Calculated states (Membership) have no state column and are unaffected.
5. **Ownership is closed over the schema.** A test lists every table with a foreign key to an aggregate root's table and fails when a table is neither owned by a declared root nor declared `NotOwned(reason)`, so a new table cannot escape the construct. A lint rule (the repository's anti-slop rule set) forbids Drizzle `insert`/`update`/`delete` on an owned table outside the aggregate writer module.
6. **Hyperdrive rules hold:** row locks inside a transaction only; no advisory locks, no session state.

## Falsifiers

1. **Type-level:** a write to `membership` without `Locked<Person>`, a `Locked<Team>` passed where `Locked<Person>` is needed, and a hand-made token all fail to type-check (type tests with `@ts-expect-error`, registered).
2. **Ordering:** 300 rounds of two `lockAll` calls over the same two persons in opposite argument order end with no 40P01; the same with a hand-written opposite-order lock (negative control) deadlocks at least once in the same bound.
3. **Overlap races stay fixed:** spec 0006 R6's 300-round insert/insert and extend/insert tests pass through the construct; removing the lock from `Aggregate.lock` makes them fail.
4. **Lost update:** 300 rounds of two concurrent transitions from the same state on one row: exactly one wins, the other gets `Conflict`; a repository method that writes the state column directly fails lint.
5. **Ownership closure:** adding a table with a foreign key to `person` and no ownership declaration fails the closure test; an owned-table `db.insert` outside the writer module fails lint.
6. **Reads never write:** the display reads still pass the SELECT-only role test; locked decision reads are not in that registry (they run inside commands).
7. `bun run ready` and `bun run e2e` pass. Race tests follow AGENTS.md: many rounds, fresh state, each loser's Cause printed on failure, round count stated.

## Out of scope

Serializable isolation and retry loops (a construct that retries hides contention instead of ordering it); Durable Objects per aggregate (rejected for this system: one Worker, Postgres is the source of truth).

## Revisions
