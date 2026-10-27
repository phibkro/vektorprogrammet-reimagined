---
name: verify-membership-writes
description: Model-check (TLA+) how concurrent writes to one person's memberships behave in PostgreSQL: the person's row lock, the `membership_no_overlap` exclusion constraint, the conditional UPDATEs and the typed errors. Use when a change touches `MembershipRepository` (`packages/db/src/repositories/teams.ts`), the Teams command handlers, the membership machine, `classifySqlFailure`, the transaction wrapper or a migration of `membership`; when a new command or repository writes memberships or takes the person's row lock (accounts, codes, placements, spec 0006b's `Aggregate.lock`); and when reviewing a pull request that does either.
---

# Verify membership writes under concurrency

**Property.** However many commands write one person's memberships at once, and however PostgreSQL interleaves their statements (a request can be cancelled at any step), no write is rolled back as a deadlock victim, no two overlapping memberships of one person in one team are both committed, "already exists" is only said when a committed membership overlaps, and a change commits only if it was legal from the membership it really replaced.

**Harm.** A deadlock victim is a 500 for a leader who did an ordinary thing and says nothing about the data (the other write can still roll back); a wrong "already exists" turns a leader away from a membership that was never made; a lost update reactivates an ended membership or shortens a term without a trace.

The tests reach this case badly: the deadlock of spec 0006 R6 passed 320 single attempts and showed in about 0.6% of contended rounds. TLC visits every interleaving of the statements of up to three commands, with a cancellation possible at every step.

## Coverage record

Everything in the model points at code that you can open: `model/Shapes.tla` lists the statements of each repository write and each command, with file and line. `run.sh` reads this block.

```coverage
sync-commit: 0795adc734dd5d980acece5fc3404116a24b84fa
packages/db/src/repositories/teams.ts
packages/domain/src/teams/commands.ts
packages/domain/src/teams/declaration.ts
packages/db/src/classifySqlFailure.ts
packages/db/src/transactional.ts
packages/db/src/schema.ts
packages/db/drizzle
apps/web/src/server/transactor.ts
```

| Covered code | What the model takes from it |
| --- | --- |
| `MembershipRepositoryLive.insert`, `setEnd`, `remove` (`teams.ts:425-543`) | the statements of each write and their order; the WHERE clause of each conditional write; "no row matched" is `lostRace`, the typed `Conflict` |
| the handlers `addMember`, `cancel`, `change`, `endEarly`, `extend` (`commands.ts:144-377`) | which repository writes each command calls, in order (`compose`) |
| `MembershipMachine` (`declaration.ts:254-313`) | the guard that decides, before the write, whether a transition is allowed (`Allowed`) |
| `membership_no_overlap` (`drizzle/20261026221817_membership_no_overlap`) | the exclusion constraint on person, team and term |
| `classifySqlFailure` (`classifySqlFailure.ts:95-145`) | `23P01` is `AlreadyExists`; `40P01` is a defect, never `AlreadyExists` |
| `transactional`, `Transactor.run` | one command is one transaction (READ COMMITTED) |

The sync commit is the last commit at which someone confirmed that `model/Shapes.tla` describes this code. **Move it forward only after you have read every change to covered code since the old one and the model describes the new code** (see "Update the model after a change").

## Run it

```sh
devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh          # about 1 minute
devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --quick  # about 35 seconds
devenv up -d postgres && devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --code
```

The `formal` profile of `devenv.nix` adds TLA+ tools 1.7.4 (TLC, with the Java 8 that nixpkgs builds them with), pinned by `devenv.lock`, with the Java heap capped; the default shell does not have them. The machine is shared: `run.sh` prints the load and stops when it is above 80% of the CPUs or under 4 GB are free (`FORCE=1` overrides). It runs one TLC at a time with 8 workers (`TLC_WORKERS`) and a 2 GB heap (`TLC_HEAP`); the largest run, three commands, took 1.6 GB resident and 20 seconds. `--code` also runs the tests of the real repositories that pin the facts that `Shapes.tla` takes from the code (needs PostgreSQL).

What a good run prints, and what each line means:

| Line | Means |
| --- | --- |
| `ok covered code is unchanged since the sync commit` | the model was confirmed against this code. `DRIFT` means a covered file changed, or a new writer of `membership` exists: the pass below describes older code |
| `current-code … pass` | all four properties hold for the code as `Shapes.tla` describes it |
| `reach-overlap-loser`, `reach-lost-transition`, `reach-lock-wait`, `reach-check-wait-on-unlocked-remove`, `reach-change-commits`, `reach-all-commit` `… fails:Never…` | the model can reach what the properties are about: an overlap loser, a lost race, a wait for the lock, a wait inside the check for an unlocked `remove`, a committed `change`, every command committed. A pass of `current-code` over a model that cannot do these would mean nothing |
| `insert-without-lock … fails:NoDeadlockAbort` and the other variants | the property can fail: this variant is the real code with one edit (table below) |
| `story-r6-deadlock` and `story-r6-fixed` | the pair that `/statechart` reads: the R6 race in a scenario small enough to draw, without and with the lock |
| `whatif-*`, `design-*` | not code: commands that the code does not have yet and the design of spec 0006b |

Exit status: `0` all as expected, `1` the code breaks a property or a variant is not caught or a code test failed, `2` tool missing or no headroom, `3` all as expected but the coverage is stale.

**In CI** (`.github/workflows/formal.yml`): every pull request runs `run.sh --touched origin/<base>`, which needs no tools and reads the coverage block above. When the diff touches a covered file, this skill, the formal profile, or adds an uncovered writer of `membership`, the job runs the full `run.sh`, and any non-zero exit, drift included, fails it. So a change to covered code merges only after the model has been confirmed against it and the sync commit moved.

## Read a result

Read every result that is not `as expected`, and the passing `current-code`, with the pstack `/statechart` skill (OMP: `skill://statechart`). It turns each broken property into its shortest path in plain words, marks which paths a change fixes, and for a passing model draws how the commands move through their states. Give it a root module (`Race`, `WhatIf`, `Pair` or `Story`), the `.cfg` that `run.sh` kept in the folder it prints, and `model/labels.map.mjs`, which words every state and step in this repository's terms ("A asks for the person's row lock and has to wait for B"). Work in a scratch folder outside the repository, as `/statechart` says. The formal profile provides the TLC and Java that it needs. The full `Race` is too large to draw quickly; give `/statechart` `Story` (two commands, an empty person) or a scenario of your own: copy `model/Story.tla` and list the plans that the counterexample used (they are in its first state).

## A run fails: bug or modeling error?

1. Take the counterexample as steps in words (`/statechart`). Each step is one SQL statement or one PostgreSQL action. `Shapes.tla` gives the file and line of every statement, and `MembershipWrites.tla` names the PostgreSQL rule of every other step.
2. **A step that the code cannot take is a modeling error.** Open the cited line. Does the code issue that statement, in that order, in that command? Fix the model so that it matches the code and say what was wrong. Never weaken the property or the bounds to make it pass.
3. **A step that PostgreSQL would not take is a modeling error.** Run `bunx vp test run test/membershipWriteModel.postgres.test.ts` in `packages/db` (PostgreSQL up). The test named after that step shows the rule on a real database. If it passes, the model's rule is right; if it fails, PostgreSQL changed and the model's rule is stale.
4. **If every step can happen, it is a bug.** Report the counterexample in the code's words, the harm in one sentence and the commit that introduced it (`git log -S'for("no key update"' -- packages/db/src/repositories/teams.ts`). Replay it on the real code when you can. The two writes of the R6 counterexample are the overlap race of `teams.postgres.test.ts`: with the lock deleted from `insert`, its 300 rounds failed with `DeadlockError: deadlock detected` (round 220 in the run that confirmed this skill) and "an insert waits for the person's row lock" failed at once. Do not change product code unless you were asked to.

## Update the model after a change

Do this when `run.sh` says `DRIFT`, or when you change covered code on purpose.

1. Read every change to covered code since the sync commit: `run.sh` prints the `git diff` command for each changed file, and it finds a new writer of `membership` as well. A writer that you add or change must be in the coverage block. For each change decide: **no effect** (formatting, comments, a person-only repository method), **the model no longer describes the code** (a statement was added, removed or moved, a WHERE condition changed, a command calls another write), or **the promise changed on purpose** (the doc comment, the tests or the spec say so; cite it).
2. Translate from the code, statement by statement, into `CurrentCode` in `model/Shapes.tla`. Write the update before you run it, and never shape it by what makes the run pass.

   | In the code | In `Shapes.tla` |
   | --- | --- |
   | `db.select(…).from(person).where(…).for("no key update")` | `lockPerson` |
   | the same through `.innerJoin(membership, …).for("no key update", { of: person })` | `lockPersonOfRow` |
   | `db.insert(membership)` | `insertRow` |
   | `db.update(membership).set(end…).where(…)` | `updateEnd`, and the conditions of its WHERE in `setEndWhere` |
   | `db.delete(membership).where(…)` | `deleteRow`, and `removeWhere` |
   | a read of the membership before the write (`beginTransition`) | `read` |
   | the `memberships.insert/setEnd/remove` calls of a handler, in order | its entry in `compose` |

3. **A statement that the model has no name for** (another table, `ON CONFLICT`, `FOR UPDATE` over a set of rows, an advisory lock, a retry, `SERIALIZABLE`) needs a new action in `MembershipWrites.tla`. First write the probe that shows the PostgreSQL rule in `membershipWriteModel.postgres.test.ts`; then the action; then a goal (`Never…`), a broken variant and their runs in `run.sh`.
4. Run `run.sh`. Then break the new code the way the property guards against (drop the new lock, reorder the new statement), make the same edit in `Shapes.tla` as a new variant, and see it caught. A pass that you have not seen fail proves nothing.
5. Commit the change to the model apart from any product change. Then set `sync-commit` above to the commit that contains the covered code you confirmed (a second small commit is fine: the diff of covered files from it to `HEAD` is still empty). Do not move it for a run that was blocked.

Spec 0006b will change this code: `Aggregate.lock` replaces the inline lock selects, writes take a `Locked<Person>`, `remove` locks too, `Machine.apply` writes the state. `WithReplaceAllWritesLocked` and `LocksInIdOrder` in `Shapes.tla` are the shapes that the spec promises. Compare the code that lands with them statement by statement.

## Broken variants

Each is `CurrentCode` with one edit that the code could get. `run.sh --list` prints them.

| Run | The code edit | Fails on | Story |
| --- | --- | --- | --- |
| `insert-without-lock`, `story-r6-deadlock` | delete `teams.ts:437-442` (the code before the fix of spec 0006 R6) | `NoDeadlockAbort` | both writes write their row and index entry, then each overlap check waits for the other's unfinished row: deadlock |
| `setend-without-lock` | delete `teams.ts:480-486` | `NoDeadlockAbort` | an extension and an insert of one person deadlock the same way |
| `insert-locks-after-write` | move the lock select after the INSERT | `NoDeadlockAbort` | both writes write before either one locks, so the checks cross: the same deadlock as without the lock |
| `setend-without-observed-end` | drop `eq(membership.endOrdinal, …observedEnd)` at `teams.ts:494` | `LegalAtApply` | two extensions read the same end; the later one shortens the term |
| `setend-unconditional` | keep only `eq(membership.id, …)` (the negative control of falsifier 3) | `LegalAtApply` | two early ends of one membership: the second applies to a membership that the first already ended |
| `no-exclusion-constraint` | drop `membership_no_overlap` (the negative control of falsifier 4) | `NoOverlapCommitted` | an insert that overlaps an existing membership commits |
| `deadlock-mapped-to-already-exists` | map `40P01` to `AlreadyExists` in `classifySqlFailure` (with the missing lock) | `RefusalsAreTrue` | the victim is told "already exists" although the other write has not committed: it can still roll back, and then nothing exists |
| `whatif-replace-without-lock` | a new command that removes, then inserts, without locking first | `NoDeadlockAbort` | `remove` takes no lock, so it holds a row that the other write waits for while it waits for the lock |
| `whatif-replace-locked-first`, `whatif-all-writes-locked` | the same command locking first, or `remove` locking (spec 0006b) | passes | no write that another command can wait on happens before the lock |
| `design-two-persons-call-order` | two persons locked in the order the caller names them | `NoDeadlockAbort` | two commands name the same two persons in opposite order |
| `design-two-persons-id-order` | `Aggregate.lockAll`: lower id first | passes | every command takes its locks in one order, so no cycle can form |

## What is verified, and what is not

- **Bounds.** Three commands at once (two for each variant), one person, semesters 1 to 4, the current semester 2, two teams, an Active membership (`r0`, team x, semesters 1 to 2) and a Planned one (`r1`, team y, semester 3), 18 command inputs (`addMember` in either team for any term from semester 2, `extend` to 3 or 4, `endEarly` from 2, `change` to either team from 2, `cancel` of the Planned membership), and a cancellation of any request at any step. The design runs use two persons and two commands. A pass is a pass for these bounds: no deadlock cycle of four or more commands, no second person, no other terms.
- **Pinned PostgreSQL rules** (each shown on PostgreSQL 18.6 by `membershipWriteModel.postgres.test.ts`): READ COMMITTED; an INSERT or a term-moving UPDATE writes its row and index entry before it checks the exclusion constraint, waits for an unfinished writer of an overlapping row, then looks again, and is refused (`23P01`) only by a committed one; a conditional UPDATE waits for the row's writer and is judged on the newest version; `FOR NO KEY UPDATE` waits for another one but not for a foreign-key check, whereas `FOR UPDATE` does; PostgreSQL rolls back exactly one member of a cycle of waits with `40P01`, and which one is not defined.
- **Left out.** The audit and outbox rows of each command (no lock or constraint that another command can wait on); foreign-key checks (they never conflict with the person lock; probed); plain reads (they never wait); a semester boundary that falls inside one command; the driver, Hyperdrive's pooling and a `lock_timeout` or `statement_timeout` (none is set in the test database; production's are not checked); `UPDATE` as one step (inside PostgreSQL, other transactions can see the old row locked before the new one has its index entry; every outcome that allows is also reachable by another order of the model's steps); writes to other tables and by other repositories, including `AccountRepository`, `CodeRepository` and `AdminGrantRepository` (see below); the importer's `TRUNCATE`; PostgreSQL other than 18.

## What pins the model to the code

| Fact in `Shapes.tla` | The test of the real code that fails if it changes (`--code`) |
| --- | --- |
| `insert` locks the person before it writes | `teams.postgres.test.ts`: "an insert waits for the person's row lock before it writes anything" |
| `setEnd` locks the person before it writes | `membershipWriteModel.postgres.test.ts`: "setEnd waits for the person's row lock before it writes anything". It is new: the 300-round extension and insert race of `teams.postgres.test.ts` takes the lock through the `insert` that precedes the extension in its transaction, so it still passes when `setEnd` loses its own lock |
| `setEnd`'s UPDATE names the end that was read | `teams.postgres.test.ts`: falsifier 3 and its negative control |
| the exclusion constraint exists | `teams.postgres.test.ts`: falsifier 4 |
| `40P01` is a defect | `classifySqlFailure.test.ts` |
| each command's calls, `remove` without a lock | nothing: only the drift check sees them. Adding a lock to `remove` is safe (spec 0006b does it), so no test pins its absence |

## Findings at the sync commit

- **The code keeps all four properties** inside the bounds. The reach goals show the model does what they are about.
- **`remove` is unlocked and safe only because it is one statement with nothing after it that can wait.** A command that deletes a membership and then writes another one before it locks the person deadlocks (`whatif-replace-without-lock`; the same on PostgreSQL in `membershipWriteModel.postgres.test.ts`). The rule for a new command is to lock the person first. Spec 0006b makes that structural.
- **Outside what is verified, found while reading spec 0007 beside this model, not fixed and not modeled.** `AdminGrantRepository.revoke` (`teams.ts`) refuses to remove "the last valid place" by counting grants, whoever holds them. `AccountRepository.transition` (`accounts.ts`) refuses to deactivate "the last Active admin" by counting Active accounts after it has locked the grants. A Deactivated person's place still counts for `revoke`. With two Active admins, `A` deactivating `C` while `C` revokes `A`'s place both succeed when `deactivate` takes the grants' lock first, and no Active admin holds a place afterwards. `C`'s request was authorized before `C` was deactivated and runs after it, as any request can (the principal is read before the transaction; spec 0007: "a deactivation bites on the next request"). Reproduction, in the style of the last-admin race of `accounts.postgres.test.ts`: two Active admins, each with a place; `transactional(AccountEndpoints.deactivate({ personId: C }))` as `A` and `transactional(TeamsEndpoints.revokeAdmin({ id: placeOfA }))` as `C`, with `CurrentPrincipal` given to each; afterwards count the people who are Active and hold a place. On PostgreSQL 18.6: 1 of 200 simultaneous rounds ended with none; when `C`'s revoke started 3 ms after the deactivation, 100 of 100. Next target for this skill: the last-admin protocol (`activeAdminIds` locks the grants in id order, then reads accounts without a lock; `revoke` locks the same grants and reads no account).

When the verification falls behind the code, follow the pstack `/maintain-formal-verification-skill` skill: it is this skill's upkeep loop.

Provenance: generated by following the pstack `create-formal-verification-skill` skill (MIT, Lauren Tan, cursor/plugins pstack 0.15.32). TLA+ tools 1.7.4 are the upstream `tla2tools.jar` (MIT) that nixpkgs packages as `tlaplus`; the model is written for this repository and copies no code.
