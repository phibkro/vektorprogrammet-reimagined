---
name: verify-membership-writes
description: Model-check (TLA+) how concurrent commands that write one person's memberships behave in PostgreSQL under spec 0006b's aggregate locks: the person's and the admin list's row locks (taken first, in one global order), the `membership_no_overlap` exclusion constraint, the conditional UPDATEs and the typed errors. Use when a change touches `packages/db/src/aggregate` (`AggregateLocks`, `Aggregates`), `MembershipRepository` (`packages/db/src/repositories/teams.ts`), the Teams or Account command handlers that lock, the membership machine, `classifySqlFailure`, the transaction wrapper or a migration of `membership`; when a new command or repository writes memberships or another table that a person owns, or takes a lock through `AggregateLocks`; and when reviewing a pull request that does either.
---

# Verify membership writes under concurrency

**Property.** However many commands write one person's memberships at once, and however PostgreSQL interleaves their statements (a request can be cancelled at any step), no write is rolled back as a deadlock victim, no write waits inside the exclusion check for another transaction's unfinished row (the writes of one person never run at the same time), no two overlapping memberships of one person in one team are both committed, "already exists" is only said when a committed membership overlaps, and a change commits only if it was legal from the membership it really replaced. The commands that change who is on the admin list take its lock before any person's, so the order of the locks never makes two commands wait for each other.

**Harm.** A deadlock victim is a 500 for a leader who did an ordinary thing and says nothing about the data (the other write can still roll back); a wrong "already exists" turns a leader away from a membership that was never made; a lost update reactivates an ended membership or shortens a term without a trace.

The tests reach this case badly: the deadlock of spec 0006 R6 passed 320 single attempts and showed in about 0.6% of contended rounds, and with the lock taken out of `AggregateLocks.lock` the 300-round overlap race failed in 2 of 5 runs (spec 0006b R3). TLC visits every interleaving of the statements of up to three commands, with a cancellation possible at every step, and finds the deadlock without the lock at once.

## Coverage record

Everything in the model points at code that you can open: `model/Shapes.tla` lists the statements of each call that a command makes (the lock, the reads, the repository writes) and of each command, with file and line. `run.sh` reads this block. An entry is a file, or a directory and everything under it.

```coverage
sync-digest: a43ab811b9a49b83bfcf384003f46918fc545fba
confirmed-at: 4c5f73e55140522fde08fca0473fa1ed47e78609
packages/db/src/live.ts
packages/db/src/repositories/teams.ts
packages/db/src/repositories/accounts.ts
packages/db/src/repositories/companyAddresses.ts
packages/db/src/repositories/workspace.ts
packages/domain/src/workspace/commands.ts
packages/domain/src/workspace/services.ts
packages/domain/src/teams/commands.ts
packages/domain/src/teams/declaration.ts
packages/domain/src/accounts/commands.ts
packages/domain/src/shared/aggregate.ts
packages/db/src/aggregate
packages/db/src/classifySqlFailure.ts
packages/db/src/transactional.ts
packages/db/src/schema.ts
packages/db/drizzle
packages/domain/src/shared/transactor.ts
```

| Covered code | What the model takes from it |
| --- | --- |
| `AggregateLocks.lock` and `lockAll` (`packages/db/src/aggregate/locks.ts:81-149`), the lock scope (`lockScope.ts:36-50`) | a lock is one `SELECT … ORDER BY id FOR NO KEY UPDATE`; a row that the transaction already holds sends no statement; a lock that would come before a held one is a defect before any statement (`orderCheck`). Since spec 0007b the statement of a root that declares a tombstone column (`person.merged_into`) also says `merged_into IS NULL`, so a person who was merged away is not found: `NotFound`, which no model command meets (see "Writers outside the model") |
| `Aggregates.insert`, `update`, `remove` (`aggregate/aggregates.ts:304-390`; `update` and `remove` build their statement with `onHeld`, `:127-162`) | each write is one statement: insert takes its owner from the token; update and remove restrict the owner to the tokens' ids (one id for a command). The token check sends none |
| `MembershipRepositoryLive.findById`, `findLocked`, `insert`, `setEnd`, `remove` (`teams.ts:479-663`) | the statements of each call; the WHERE clause of each conditional write; "no row matched" is `lostRace`, the typed `Conflict` |
| the handlers `createMembership`, `deleteMembership`, `changeMembership`, `endEarlyMembership`, `extendMembership`, `createAdminGrant`, `deleteAdminGrant` (`teams/commands.ts`) and `deactivateAccount`, `reactivateAccount` (`accounts/commands.ts:197-198, 223-224`) | which locks and repository calls each command makes, in order (`compose`); `beginTransition` (`teams/commands.ts:118-148`) is find, lock, read, decide |
| `WelcomeLedger.claim` (`packages/db/src/repositories/teams.ts`) | its write uses the same Person token; it adds no lock. The model does not prove welcome-message uniqueness; `welcome.postgres.test.ts` tests that separately. |
| Workspace assignment and shared address claims (`workspace/commands.ts`, `repositories/companyAddresses.ts`) | Person locks precede address claims; multiple people lock by id and multiple addresses claim by address. `Address.tla` checks two projections with two addresses each; the PostgreSQL probe pins unique-insert waiting. Profile and team edits claim one address each. |
| `AggregateRoots`, `lockAdminList` (`shared/aggregate.ts`) | the admin list's lock comes before every person's |
| `MembershipMachine` (`declaration.ts:274-352`) | the guard that decides, after the lock, whether a transition is allowed (`Allowed`) |
| `membership_no_overlap` (`drizzle/20261026221817_membership_no_overlap`) | the exclusion constraint on person, team and term |
| `classifySqlFailure` (`classifySqlFailure.ts:99-158`) | `23P01` is `AlreadyExists`; `40P01` is a defect, never `AlreadyExists` |
| `transactional`, `Transactor.run` | one command is one transaction (READ COMMITTED, begun by an explicit `BEGIN ISOLATION LEVEL READ COMMITTED` since spec 0018) |
| `liveLevel`, `verified` (`packages/db/src/live.ts`, spec 0019) | the proof check that runs before every `Requires` method (every `lock`, `lockAll`, and repository write of the model) and the registration that wraps each transaction level (a per-connection stack of the levels, each with its proof and a count of the methods running on it; a nested level is entered before its `SAVEPOINT`, left after its `ROLLBACK TO` or `RELEASE`, and refused while a method of the level around it is running; the check wants the top of the stack). The model takes both as sending no statement, taking no lock and waiting for nothing: a change that adds a statement, a lock or a wait there, in front of a command's first statement, changes what the model is a model of, so the file is covered and its digest is part of the confirmation |

The `sync-digest` is the digest of the covered paths at the last confirmation. `confirmed-at` records the human-readable commit for reference only. Squash-merging does not invalidate the content digest. After reviewing the changes and confirming the model describes the code, compute the new value with `run.sh --digest` and record it here (see "Update the model after a change"). The confirmation of 2026-10-27 (spec 0007b) covers the commands in `compose`: the aggregate writes now accept several locks and use `IN`, which for the one token held by these commands selects the same rows as before. The tombstone filter and the writers in the next section are outside the model.

After the 0007d rebase, the model was run again with `--code`. The membership-machine additions declare metadata for effx; they do not change transitions. The added retention-report migration changes only the audit action constraint. Neither changes the modeled statements.

After spec 0007b and spec 0008 met (the merge of main into the 0008 branch, 2026-10-27), the model ran again with `--code` on the merged tree: every run as expected (1,712,396 states for `current-code`, every broken variant caught) and the 53 PostgreSQL code tests passed. Neither side's covered changes add a statement, lock or table to a membership command: 0007b's writers and its tombstone filter are described above, and the welcome claim, the address claims and the Workspace projection are the rows above and the `Address.tla` model. The `file:line` pointers that the merge moved were recomputed: `repositories/teams.ts` shifted by the seven lines of `PersonRepository.create` (the creation date and the optional address claim), the SQLSTATE mapping in `classifySqlFailure.ts` moved by 0007b's `isConstraintViolation` and the group-address outcome, and the `updatePerson` entry of `compose` now points at `accounts/commands.ts`, where the handler is.

Spec 0008b (outbox delivery on Queues, 2026-10-28) changed two covered paths: `packages/db/src/schema.ts` and `packages/db/drizzle`, by one nullable column `outbox.queued_at` and its migration. The table is not `membership`, and no modeled statement, lock or constraint changed. The model ran again with `--code` on that tree: every run as expected (1,712,396 states for `current-code`, every broken variant caught) and the 53 PostgreSQL code tests passed.

Spec 0018 (store guarantees as properties, 2026-10-28) changed two covered paths that matter to the model. `packages/db/src/transactional.ts` now begins a top-level transaction with `BEGIN ISOLATION LEVEL READ COMMITTED`, so the level that the model always assumed (the PostgreSQL default, "READ COMMITTED" above) is stated by the code and no longer depends on the role's default; no statement, lock or constraint that a command issues changed. `packages/domain/src/shared/aggregate.ts` and the Teams and Accounts service files changed their documentation and add `InTransaction` to the signatures of the methods that take a `Locked` token: types only. The model ran again with `--code` on that tree: every run as expected and the 53 PostgreSQL code tests passed; the digest and `confirmed-at` above are the new ones.

Spec 0018 review round 1 (2026-10-28) moved the explicit `BEGIN` of `transactional.ts` into an exported `atReadCommitted`, which `transactional` and the legacy importer's transaction both use (the importer is not a membership writer and is not covered). The statement that a command's transaction sends is the same, so no modeled statement, lock or constraint changed. The model ran again with `--code`: every run as expected and the 53 PostgreSQL code tests passed; the digest and `confirmed-at` above are the new ones.

Spec 0018 review round 3 (2026-10-28) changed the first comment line of `packages/db/src/transactional.ts` ("The only provider" became "The one production provider … a source test guards against another") and nothing else of a covered file; the digest moved with the text. No statement, lock or constraint changed. The model ran again with `--code`: every run as expected and the 53 PostgreSQL code tests passed; the digest and `confirmed-at` above are the new ones.

Spec 0019 (the live transaction proof, 2026-10-28) changed covered paths: `transactional.ts` makes a fresh `InTransaction` proof for each level (`liveLevel`, in the new `packages/db/src/live.ts`), and `repositories/{teams,accounts,workspace}.ts` and `aggregate/locks.ts` build their services through `verified`, which runs a check of that proof in front of each method that requires `InTransaction`, before the method's first statement. The check reads two context entries and a `WeakMap` and sends nothing, so no modeled statement, lock, order or constraint changed. The registry became a per-connection stack in review round 2, and in round 3 (spec 0019 R14) the stack carries a count of the methods running on each entry: a nested level is refused while a method of the level around it runs, so a `SAVEPOINT` cannot fall between the statements of a method. The model's commands each run one method at a time inside one level, so they are the case that the check passes, and the interleavings that the model explores are those of separate transactions on separate connections, which the check does not touch. `live.ts` is in the coverage block (review round 1): the model's claim that every command's first statement is its lock rests on that check sending nothing and waiting for nothing, so a later edit there is a covered change. Every `file:line` that `Shapes.tla` and this file cite in `teams.ts`, `locks.ts` and `transactional.ts` was recomputed against the final head by opening each line (`teams.ts` +7, `locks.ts` +1, `transactional.ts` now 44-76); two pointers that were already off before this change were corrected too (`workspace/commands.ts:237`, `teams/commands.ts:200-206`). The model ran again with `--code` after each change of `live.ts`: every run as expected (1,712,396 states for `current-code`, every broken variant caught) and the 53 PostgreSQL code tests passed; the digest and `confirmed-at` above are the new ones.

Spec 0021 (retention arithmetic in Effect, 2026-10-28, review round 1) changed one covered path, `packages/db/drizzle`, with the migration `drop_retention_oracle`. It drops the view `person_last_activity_end`, which read `membership` and never wrote it, and the function `semester_end`. No writer, statement, lock or constraint of `membership` changed, and `membership_no_overlap` is untouched. The same spec changes how the nightly retention run decides who is due (the domain decides from facts that the run reads after it has locked the chunk of people, `personalData/activity.ts`); that writer is outside the model as before, and its statements on `membership` (the delete under the chunk's locks) are the same. The model ran again with `--code` on that tree: every run as expected (1,712,396 states for `current-code`, every broken variant caught) and the 53 PostgreSQL code tests passed; the digest and `confirmed-at` above are the new ones (`confirmed-at` is the head that the spec's pull request had when the migration was added).

## Writers outside the model (spec 0007b)

Two writers of `membership` came with the personal data engine, and the model has no action for either. They keep the discipline that the model checks, and they are raced by tests instead. This section is the honest limit of the confirmation below: **the model describes the commands in `compose`, and not these.**

| Writer | What it does to `membership` | The discipline it keeps | Where it is raced |
| --- | --- | --- | --- |
| `mergePersons` (`packages/db/src/personalData/merge.ts`, `Aggregates.reassign`) | `UPDATE … SET person_id = <survivor> WHERE person_id = <merged>`: a statement that the model does not name, because it changes the owner column. A moved row that would overlap one of the survivor's is refused by `membership_no_overlap` and returned as the rule's typed `Conflict`. | The admin list's lock, then both people in one `lockAll` (ascending), before the first write, so no other writer of either person's rows runs at the same time. | `packages/db/test/personalDataMergeRace.postgres.test.ts`: 300 rounds each of a merge against a membership write, a profile write, an invite and a consent answer, both interleavings, with controls; `personalDataMerge.postgres.test.ts`: 20 concurrent merges of one pair. |
| The nightly retention run (`personalData/retention.ts`, `Aggregates.remove` over several owners) | `DELETE … WHERE person_id IN (<locked chunk>) AND <the declared expiry>`: the history of an engagement ten years after its term. | One transaction. The people of each chunk are locked with `lockAll` in ascending order, and the chunks follow in ascending order, so the order of the locks is global. It takes no admin list lock: a valid admin place counts as activity until it ends, so the run never expires a person whose place still counts (spec 0007b R1 items 1 and 8). | `retentionPeople.postgres.test.ts`: 20 concurrent runs end in the same state; a run waits for a person's lock that another transaction holds, shown by `meetsHeldLock`, with its control. |

A third fact has no model command either: since the merge, `lock` of a merged-away person finds no row and answers `NotFound`. In READ COMMITTED a lock that waited for the merge's transaction re-reads the row when the merge commits (PostgreSQL evaluates the WHERE again on the new row version), finds `merged_into` set, and returns no row. The merge race tests run both orders. To bring any of these into the model, follow "Update the model after a change" step 3: a probe in `membershipWriteModel.postgres.test.ts` for the PostgreSQL rule, then the action (`moveRows`, `deleteMany`, a lock that finds no row), a goal, a broken variant and their runs.

## Run it

```sh
devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh          # about 1.5 minutes
devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --quick  # about 45 seconds
devenv up -d postgres && devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --code
devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh --digest  # print the covered-path digest for the coverage block
```

The `formal` profile of `devenv.nix` adds TLA+ tools 1.7.4 (TLC, with the Java 8 that nixpkgs builds them with), pinned by `devenv.lock`, with the Java heap capped; the default shell does not have them. The machine is shared: `run.sh` prints the load and stops when it is above 80% of the CPUs or under 4 GB are free (`FORCE=1` overrides). It runs one TLC at a time with 8 workers (`TLC_WORKERS`) and a 2 GB heap (`TLC_HEAP`); the three-command run visited 1,712,396 states in 45 seconds on 2026-10-27. `--code` also runs the tests of the real repositories that pin the facts that `Shapes.tla` takes from the code (needs PostgreSQL): the files in `code_tests` of `run.sh`.

`--code` requires `bun install` and runs its PostgreSQL tests in the default devenv shell, using this worktree's allocated port rather than the formal profile's port. It prints the port before the tests.

What a good run prints, and what each line means:

| Line | Means |
| --- | --- |
| `ok covered code digest matches SKILL.md` | the model was confirmed against this code. `DRIFT` means the HEAD digest differs from the recorded digest, or a new writer of `membership` exists. |
| `current-code … pass` | all five properties hold for the code as `Shapes.tla` describes it |
| `reach-overlap-loser`, `reach-lost-transition`, `reach-lock-wait`, `reach-list-wait`, `reach-person-wait-holding-list`, `reach-change-commits`, `reach-all-commit`, `reach-order-violation`, `reach-pair-order-violation` `… fails:Never…`, and `reach-check-wait … fails:NoWaitInCheck` | the model can reach what the properties are about: an overlap loser, a lost race, a wait for a person's lock, a wait for the admin list's lock, a wait for a person's lock while holding the list's, a committed `changeMembership`, every command committed, a lock refused as out of order, and a wait inside the exclusion check (which only a missing lock allows). A pass of `current-code` over a model that cannot do these would mean nothing |
| `lock-takes-no-row-lock … fails:NoDeadlockAbort` and the other variants | the property can fail: this variant is the real code with one edit (table below) |
| `story-r6-deadlock` and `story-r6-fixed` | the pair that `/statechart` reads: the R6 race in a scenario small enough to draw, without and with the lock |
| `whatif-*`, `lockall-*` | the hypothetical membership command and `AggregateLocks.lockAll` over two people, now also used by Workspace assignment |
| `address-order`, `address-opposite-order`, `address-reach-conflict` | sorted address claims have no two-transaction wait cycle; reversing one order makes the cycle reachable, and a committed claim can refuse a contender |

Exit status: `0` all as expected, `1` the code breaks a property or a variant is not caught or a code test failed, `2` tool missing or no headroom, `3` all as expected but the coverage is stale.

**In CI** (`.github/workflows/formal.yml`): every pull request runs `run.sh --touched origin/<base>`, which needs no tools and reads the coverage block above. `run.sh --touched origin/main` decides applicability. When the diff touches covered code, this skill, the formal profile, or adds an uncovered writer of `membership`, formal.yml runs the full model with `FORCE=1` and `TLC_WORKERS=2`. Any non-zero exit, including digest drift (exit 3), fails the job.

## Read a result

Read every result that is not `as expected`, and the passing `current-code`, with the pstack `/statechart` skill (OMP: `skill://statechart`). It turns each broken property into its shortest path in plain words, marks which paths a change fixes, and for a passing model draws how the commands move through their states. Give it a root module (`Race`, `WhatIf`, `Pair` or `Story`), the `.cfg` that `run.sh` kept in the folder it prints, and `model/labels.map.mjs`, which words every state and step in this repository's terms ("A asks for the person's row lock and has to wait for B"). Work in a scratch folder outside the repository, as `/statechart` says. The formal profile provides the TLC and Java that it needs. The full `Race` is too large to draw quickly; give `/statechart` `Story` (two commands, an empty person) or a scenario of your own: copy `model/Story.tla` and list the plans that the counterexample used (they are in its first state).

## A run fails: bug or modeling error?

1. Take the counterexample as steps in words (`/statechart`). Each step is one SQL statement or one PostgreSQL action. `Shapes.tla` gives the file and line of every statement, and `MembershipWrites.tla` names the PostgreSQL rule of every other step.
2. **A step that the code cannot take is a modeling error.** Open the cited line. Does the code issue that statement, in that order, in that command? Fix the model so that it matches the code and say what was wrong. Never weaken the property or the bounds to make it pass.
3. **A step that PostgreSQL would not take is a modeling error.** Run `bunx vp test run test/membershipWriteModel.postgres.test.ts` in `packages/db` (PostgreSQL up). The test named after that step shows the rule on a real database. If it passes, the model's rule is right; if it fails, PostgreSQL changed and the model's rule is stale.
4. **If every step can happen, it is a bug.** Report the counterexample in the code's words, the harm in one sentence and the commit that introduced it (`git log -S'for("no key update"' -- packages/db/src/aggregate/locks.ts`). Replay it on the real code when you can. The two writes of the R6 counterexample are the overlap race of `teams.postgres.test.ts`: with `.for("no key update")` deleted from `locks.ts`, the model fails at once (`lock-takes-no-row-lock`), the 300-round race failed with `DeadlockError: deadlock detected` in 2 of 5 runs, and the lock-wait control and the unconditional-update control failed in all five (spec 0006b R3). Do not change product code unless you were asked to.

## Update the model after a change

Do this when `run.sh` says `DRIFT`, or when you change covered code on purpose.

1. Review covered-code changes since `confirmed-at` when that commit is available; the digest itself is the authority for drift. `run.sh` prints per-file `git diff` hints when possible and finds new writers of `membership` too: a file that writes the table with Drizzle or SQL, or names the handle `owned.membership` through which the aggregate writer reaches it (tests are not writers). A writer that you add or change must be in the coverage block. For each change decide whether the model still describes the code.
2. Translate from the code, statement by statement, into `CurrentCode` in `model/Shapes.tla`. Write the update before you run it, and never shape it by what makes the run pass.

   | In the code | In `Shapes.tla` |
   | --- | --- |
   | `AggregateLocks.lock("Person", id)` (`lockAll` of one id: `SELECT … ORDER BY id FOR NO KEY UPDATE`) | `lockPerson`; `lockPersonOfRow` for the person of a membership that `findById` found |
   | `lockAdminList` | `lockAdminList` |
   | `lockAll("Person", [a, b])` | `lockLowerPerson` then `lockHigherPerson` (the statement takes its rows one at a time, lowest first) |
   | `MembershipRepository.findById`, `findLocked` | `find`, `read` |
   | `aggregates.insert(…, owned.membership, …)` | `insertRow` |
   | `aggregates.update(…, owned.membership, { where })` | `updateEnd`, and the conditions of its WHERE in `setEndWhere` |
   | `aggregates.remove(…, owned.membership, where)` | `deleteRow`, and `removeWhere` |
   | the lock and repository calls of a handler, in order | its entry in `compose`, each call named in `repo` |

3. **A statement that the model has no name for** (another table, `ON CONFLICT`, `FOR UPDATE` over a set of rows in no stated order, an advisory lock, a retry, `SERIALIZABLE`) needs a new action in `MembershipWrites.tla`. First write the probe that shows the PostgreSQL rule in `membershipWriteModel.postgres.test.ts`; then the action; then a goal (`Never…`), a broken variant and their runs in `run.sh`.
4. Run `run.sh`. Then break the new code the way the property guards against (drop the new lock, reorder the new statement), make the same edit in `Shapes.tla` as a new variant, and see it caught. A pass that you have not seen fail proves nothing.
5. Commit the change to the model apart from any product change. After confirming the model against the code, record `run.sh --digest` as `sync-digest` and the reference commit as `confirmed-at`. Do not update either after a run that was blocked.

Spec 0006b changed this code, and this model describes the result: the lock is the command's first statement (`AggregateLocks`), a write takes the lock's token, the decision reads through it, and the admin list is the first lock. A new command that takes a lock needs an entry in `compose`; a new write to a table that a person owns needs one only for its locks, unless it is `membership`.

## Broken variants

Each is `CurrentCode` with one edit that the code could get (two edits, where the code stays safe with one). `run.sh --list` prints them.

| Run | The code edit | Fails on | Story |
| --- | --- | --- | --- |
| `lock-takes-no-row-lock`, `story-r6-deadlock`, `reach-check-wait` | delete `.for("no key update")` at `locks.ts:117` (mutation M1 of spec 0006b R3; the code before the fix of spec 0006 R6) | `NoDeadlockAbort`, `NoWaitInCheck` | every lock, a person's and the admin list's, becomes a plain read: both writes write their row and index entry, then each overlap check waits for the other's unfinished row: deadlock |
| `decide-before-lock` | `beginTransition` decides on `findById` (an unlocked read) and locks afterwards | passes | the conditional UPDATE catches a stale decision: a second guard |
| `decide-before-lock-without-observed-end` | the same, and drop `eq(membership.endOrdinal, …observedEnd)` at `teams.ts:614` | `LegalAtApply` | two extensions read the same end; the later one shortens the term |
| `decide-before-lock-unconditional` | the same, and keep only `eq(membership.id, …)` at `teams.ts:613` | `LegalAtApply` | two early ends of one membership: the second applies to a membership that the first already ended |
| `setend-unconditional` | keep only `eq(membership.id, …)`, the decision still under the lock (the control of `teams.postgres.test.ts` that spec 0006b R1 item 10 changed) | passes | the lock alone keeps every commit legal; each guard alone is enough |
| `no-exclusion-constraint` | drop `membership_no_overlap` (the negative control of falsifier 4) | `NoOverlapCommitted` | an insert that overlaps an existing membership commits |
| `deadlock-mapped-to-already-exists` | map `40P01` to `AlreadyExists` in `classifySqlFailure` (with the missing lock) | `RefusalsAreTrue` | the victim is told "already exists" although the other write has not committed: it can still roll back, and then nothing exists |
| `list-after-person`, `reach-order-violation` | `deleteAdminGrant` locks the holder before the admin list | passes | the registry refuses the second lock as a defect before it sends a statement, so no wait can form |
| `list-after-person-unchecked` | the same, and delete the order check (`locks.ts:96-104`) | `NoDeadlockAbort` | `createAdminGrant` holds the list and waits for the person; `deleteAdminGrant` holds the person and waits for the list |
| `whatif-replace-writing-first` | a new command that removes, then locks and inserts, around the construct | `NoDeadlockAbort` | the DELETE holds a row that the other write waits for while it waits for the lock |
| `whatif-replace-through-construct` | the same command through the token: `beginTransition`, `remove`, `insert` | passes | the token makes the lock the first statement, so nothing that another command can wait on happens before it |
| `lockall-id-order` | `AggregateLocks.lockAll`: the lower id first | passes | every command takes its locks in one order, so no cycle can form |
| `lockall-call-order-by-hand` | two persons locked as SQL in the order the caller names them (the negative control of falsifier 2) | `NoDeadlockAbort` | two commands name the same two persons in opposite order |
| `lockall-call-order-through-registry`, `reach-pair-order-violation` | the same two calls through `AggregateLocks.lock` | passes | the registry refuses the lock that comes after a higher id |
| `address-opposite-order`, `address-reach-conflict` | reverse one projection's address claim order; or assert no claim ever conflicts | `NoWaitCycle`, `NeverConflict` | the reversed order reaches a two-transaction cycle; the real order reaches a typed refusal |

## What is verified, and what is not

- **Bounds.** The membership model checks three commands (two in broken variants), one person, two teams and semesters 1–4, with 22 command inputs including Workspace and profile lock-only commands and cancellation at each step. `lockall-*` checks two people. `Address.tla` separately checks two transactions, four people and two shared addresses; it abstracts unique-index waiting but not cancellation, the combined membership/namespace model, or a cycle of three transactions. PostgreSQL probes check rollback, and race tests exercise projection vs team and profile edits for 300 rounds each.
- **Pinned PostgreSQL rules** (each shown on PostgreSQL 18.6 by `membershipWriteModel.postgres.test.ts`): READ COMMITTED; an INSERT or a term-moving UPDATE writes its row and index entry before it checks the exclusion constraint, waits for an unfinished writer of an overlapping row, then looks again, and is refused (`23P01`) only by a committed one; a conditional UPDATE waits for the row's writer and is judged on the newest version; `FOR NO KEY UPDATE` waits for another one but not for a foreign-key check, whereas `FOR UPDATE` does; `SELECT … ORDER BY id FOR NO KEY UPDATE` over several rows takes them one at a time, lowest first, and waits for a row that another transaction holds while it keeps the rows before it; PostgreSQL rolls back exactly one member of a cycle of waits with `40P01`, and which one is not defined.
- **Left out.** The audit and outbox rows of each command (no lock or constraint that another command can wait on); foreign-key checks (they never conflict with the person lock; probed); plain reads (they never wait); a semester boundary that falls inside one command; the driver, Hyperdrive's pooling and a `lock_timeout` or `statement_timeout` (none is set in the test database; production's are not checked); `UPDATE` as one step (inside PostgreSQL, other transactions can see the old row locked before the new one has its index entry; every outcome that allows is also reachable by another order of the model's steps); the rows of the other tables that a person owns (`admin_grant`, `account`, `code`) and the repositories that write them: their commands appear only as the locks they take, and a unique index on another column (`code_hash_unique`, an e-mail address) could make writes of two different persons wait for each other, which this model does not check; the importer's `TRUNCATE`; PostgreSQL other than 18.
- **Unique-address wait.** `membershipWriteModel.postgres.test.ts` observes a competing `INSERT … ON CONFLICT DO NOTHING` waiting in PostgreSQL and checks its row count after the first claimant commits or rolls back.
- **Welcome claim.** The first-membership history read, the Person-owned claim on creation or cancellation, and outbox messages do not change the modeled membership rows or acquire a second root lock. Their atomicity and uniqueness are PostgreSQL tests, not a conclusion of this model.
- **Not checked: whether an Active administrator is left.** The model checks the order of the admin list's lock, not the decision that the lock protects. `createAdminGrant`, `deleteAdminGrant`, `deactivateAccount` and `reactivateAccount` take the list's lock before any person's, so they cannot take part in a cycle with a person's lock, and a person's lock before the list's is refused as a defect (`list-after-person`, `reach-order-violation`). The model has no `admin_grant` or `account` rows, so no property of it says that an Active administrator with a valid place is always left: that is the rule of spec 0006b R2 (`activeAdminPlaces`, `AccountRepository.isLastActiveAdmin`, `AdminGrantRepository.revoke`). Its evidence is the race tests that `--code` runs. `adminList.postgres.test.ts` has 300 rounds of a deactivation against a revocation, with and without the deactivation's write held back, the control that decides under each person's lock only (it leaves no Active administrator with a place in every round), the stale principal, and each of the four commands waiting for the list's row lock with nothing written. `teams.postgres.test.ts` has two 300-round tests of two revocations at once. Spec 0007's 300 rounds of racing deactivations (`accounts.postgres.test.ts`) run in `vp run -r test`, not in `--code`. A change that drops a command's list lock is not a TLC failure, because `Shapes.tla` still says that the command takes it. The covered file changes, so `run.sh` reports DRIFT until the model has been read against the change and the digest recorded, and the race and lock-wait tests above fail (spec 0006b R2 item 5 lists what each weakened guard breaks).

## What pins the model to the code

| Fact in `Shapes.tla` | The test of the real code that fails if it changes (`--code`) |
| --- | --- |
| `lock` takes `FOR NO KEY UPDATE` on the person's row | `teams.postgres.test.ts`: "falsifier 3, lock-removal control: an insert waits for the person's row lock before it writes anything" (it fails in every run without the lock, and when the insert writes a row before its lock); and the five command tests of `membershipWriteModel.postgres.test.ts` |
| each command takes the person's lock before it writes (`compose`) | `membershipWriteModel.postgres.test.ts`, last block: `createMembership`, `extendMembership`, `endEarlyMembership`, `changeMembership` and `deleteMembership` each wait for a person's lock that another session holds, and PostgreSQL shows the waiting backend with no write lock and no transaction id (read from `pg_locks` and `pg_stat_activity`: another session cannot read an uncommitted row, so a read of the table could not fail); once the lock is let go the command writes a membership. A membership written before the lock fails all five on `wrote`, and a row lock on another table fails them on `hasTransactionId` (spec 0006b R4) |
| the decision read comes after the lock | `teams.postgres.test.ts`: "falsifier 3, lock-removal control: the person's lock alone keeps the successes legal, even when the update is unconditional" (it fails when the lock goes, and when a command decides before it) |
| a write cannot happen without the lock | `aggregate.types.test.ts` (a write without the token does not type-check) and `aggregates.postgres.test.ts` ("a token that no lock made … never reads or writes") |
| `lockAll` is one statement ordered by id that takes its rows lowest first, one at a time | `membershipWriteModel.postgres.test.ts`: "lockAll is one statement ordered by id …"; `aggregates.postgres.test.ts`: falsifier 2, 300 rounds of two `lockAll` calls in opposite order and its hand-written control |
| the admin list's lock comes first, and a lock out of order is a defect that sends no statement | `aggregates.postgres.test.ts`: "a lock that would break the global order is a defect" and "the admin list comes before every person"; `adminList.postgres.test.ts`: each of the four commands waits for the list's row lock with no write lock and no transaction id |
| `setEnd`'s UPDATE names the end that was read (a second guard) | `teams.postgres.test.ts`: falsifier 3 |
| the exclusion constraint exists | `teams.postgres.test.ts`: falsifier 4 |
| `40P01` is a defect | `classifySqlFailure.test.ts` |

## Findings at the confirmed commit

- **The code keeps all five properties** inside the bounds, `NoWaitInCheck` included: with every write under the person's lock, no write ever waits inside the exclusion check. The reach goals show the model does what they are about.
- **Two guards, either enough.** The conditional UPDATE and the lock each keep every commit legal alone (`decide-before-lock`, `setend-unconditional`); only the two removed together break it. That is spec 0006b R1 item 10 as a verdict of the model, and the reason that the R6 negative control no longer fails.
- **A command written around the construct still deadlocks** (`whatif-replace-writing-first`; the same on PostgreSQL in `membershipWriteModel.postgres.test.ts`). The token and the lint rule `no-owned-table-write` make that command impossible to write for a table that a person owns.
- **Outside what is verified: the last-administrator decision.** See "What is verified, and what is not": the model shows that the admin list's lock is taken first and cannot take part in a cycle, and the race tests that `--code` runs are the evidence for the rule itself.

When the verification falls behind the code, follow the pstack `/maintain-formal-verification-skill` skill: it is this skill's upkeep loop.

Provenance: generated by following the pstack `create-formal-verification-skill` skill (MIT, Lauren Tan, cursor/plugins pstack 0.15.32). TLA+ tools 1.7.4 are the upstream `tla2tools.jar` (MIT) that nixpkgs packages as `tlaplus`; the model is written for this repository and copies no code.
