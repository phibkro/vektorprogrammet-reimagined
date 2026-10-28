# Spec 0018: Store guarantees as properties (ADR 0014, stage 2)

**Status:** frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** ADR 0014 (`docs/decisions/0014-store-capabilities.md`), accepted by the operator on 2026-10-28: decision 1 (a guarantee is declared with a named strength; `InTransaction` states its isolation), the staged plan's row 2, and answers 1, 2 and 7 · **Evidence:** the repository at main `336fcde` (every `file:line` below was read at that head; the ADR's map was read at `f4bfe78`, and several of its test line numbers have moved, so tests are cited by file and title unless a line was re-read) · **Stacked on:** spec 0017 (merged, PR #45). Stage 2 touches no schema and no migration.

## Journey

Stage 2 changes what the domain says about the store, and two type signatures' worth of what a caller may do. Nothing a user sees moves. Its journeys are a developer's, an adapter author's and a reviewer's.

1. **A developer calls the outbox outside a transaction.** She writes `yield* (yield* Outbox).enqueue([mail])` in a function that nobody wrapped in `Transactor.run`. `vp check` fails: the program needs `InTransaction`, which nothing provides. Today the same program type-checks and commits an outbox row with no command behind it (`Outbox.enqueue` has no requirement: `packages/domain/src/shared/outbox.ts:83-86`). The same holds for `AuditLog.record`, `DigestLedger.claim` and `AlumniRequests.claim`.
2. **An adapter author reads one page.** She opens `docs/system/store-guarantees.md` (generated from `packages/domain/src/shared/guarantees.ts`) and finds, for each capability, each guarantee as a property of an abstract store: what it says, whether the store itself keeps it against every writer (`store-enforced`) or only against writers that use the port (`port-enforced`), the port methods that carry it, and the isolation that `InTransaction` promises. No sentence of it names SQL, a PostgreSQL feature or a table.
3. **A reviewer adds a port method.** She adds `Claims.release` to a port and forgets to say whether it needs a transaction. The type check fails on the declaration of transaction modes, which has no row for the method.
4. **An operator moves the database to a role with a stricter default.** The Neon role gets `default_transaction_isolation = 'serializable'`. Every domain transaction still runs at READ COMMITTED, because `transactional` says so in its `BEGIN`. Without this, the model-checked protocol (spec 0006b) and "no retries" (spec 0006b) would silently stop holding: the first serialization failure would be a defect.
5. **Nothing a user sees moves** (falsifier 8).

## Goal, constraints, values

- **Goal:** ADR 0014's stage 2: each store guarantee is written as a property in the domain (not as SQL), with its strength; `InTransaction` states the isolation it promises; `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim` and `AlumniRequests.claim`, and every other port method that silently assumes a transaction, require `InTransaction`; the type tests of the ADR's falsifier fail when one of them is called outside a transaction; the snapshot assumptions of `exportOf` and `PrincipalDirectory` are stated.
- **Constraints:**
  - **No schema, no migration, no change to a command, grant row, error table or generated document of an existing domain.** The one runtime change is the text of `BEGIN` (falsifier 4).
  - **Domain stays pure.** `packages/domain` gains data declarations and tests. It imports nothing from `db`, `web`, Drizzle, `pg` or `@effect/sql*`.
  - **The invariants are store-enforced** (ADR answer 2). Every guarantee that is a predicate of one committed state is declared `store-enforced`; the declaration refuses a port-enforced invariant (falsifier 3). The last-administrator rule is not one, and the spec says why (see [the catalogue](#the-guarantees)).
  - **Minimum isolation READ COMMITTED plus aggregate locks; a stronger store is allowed** (ADR answer 7). The domain states the floor; no adapter is required to be at it exactly. Serializable-with-retries stays rejected (spec 0006b).
  - **No new service.** The capabilities of ADR decision 1 are names for groups of guarantees here; their carriers are the existing ports. Folding the ports into capability services belongs with the contract suites (stage 3), which decide the surface.
  - **No shims, every commit green.** The 21 signatures change in the commits that update their callers and tests.
  - **Latency is reported, not gated** (ADR answer 6). The only runtime change is the `BEGIN` text; the build reports p50 and p95 of one command per the ADR's method (100 timed after 20 warmups) and flags p95 above 500 ms.
- **Values:** one home per fact (the declaration is the root; the document, the port comments and the tests derive from it or reference its ids); a type error beats a test beats a review; the smallest move that satisfies the ADR's falsifier.

## Vocabulary

Store-neutral words, so that the property does not name a mechanism.

| Word | Meaning |
| --- | --- |
| **record**, **key** | what a port reads and writes; the natural identity of a record (a city, an e-mail address, a person and a team) |
| **transaction** | the scope `Transactor.run` opens and `InTransaction` proves; **nested scope** is a `run` inside a `run` |
| **committed state** | what other transactions can see: every transaction that has succeeded, and none that has not |
| **root**, **token** | an aggregate root (a person, the admin list) and the `Locked` proof that the running transaction holds its lock (spec 0006b) |
| **raw writer** | a writer that writes valid data straight into the store without the port: the importer, a migration, a script, an adapter of another application |

**Strength is decided by one question, which stage 3 turns into a test for every row:** can a raw writer make the property false for a program that uses the port? If the store refuses the write, or the property survives it, the guarantee is `store-enforced`. If the raw writer succeeds, it is `port-enforced`. A property of reading (a snapshot) is false under no writer, so it is `store-enforced`, though an adapter must still read in one go to provide it. An **invariant** is a predicate of one committed state (at most one record per key). A rule about which commands may commit, or about histories (a state machine's legal transitions), is not one; the declaration records the difference (`invariant: boolean`) because ADR answer 2 binds only invariants.

**Transaction mode of a port method** (new, one per method):

| Mode | Meaning | Type |
| --- | --- | --- |
| `Requires` | its guarantee spans writes, or rests on a lock; it is meaningless outside a transaction | `InTransaction` in its requirements |
| `Standalone` | one atomic statement or an idempotent write; complete when it commits alone, and a caller may still put it inside a transaction | none |
| `Joins` | one conditional statement that commits alone, or with the caller's writes when the caller is in a transaction | none (it cannot require what it does not need) |
| `Read` | writes nothing and takes no lock | none |
| `Outside` | provider I/O: never run inside a transaction (convention: the type system cannot forbid it) | none |
| `Opens` | opens its own transaction and takes none: a top-level operation (`Transactor.run`, `ImportTarget.replaceAll`) | none |

## Inventory at `336fcde`

### A. The ADR's four: methods that assume a transaction and do not say so in their type

| Method | Declared | What it says | Adapter | Production callers |
| --- | --- | --- | --- | --- |
| `Outbox.enqueue` | `packages/domain/src/shared/outbox.ts:80-87` | "Inserts the messages in the current transaction" (`:83`) | `packages/db/src/repositories/outbox.ts:74-106` | `accounts/commands.ts:124` (through `queueCredential`, called at `:159` and `:305`), `:176`, `:277`; `contact/commands.ts:50`; `personalData/commands.ts:412`; `teams/commands.ts:326`; `teams/endingSoon.ts:178`; `workspace/commands.ts:311` |
| `AuditLog.record` | `packages/domain/src/audit/auditLog.ts:75-83` | "Inserts one audit row in the current transaction" (`:78`) | `outbox.ts:498-514` | `recordAudit` (`auditLog.ts:90`), which the command handlers of eight files call (`accounts`, `content`, `files`, `organisation`, `personalData`, `teams`, `teams/endingSoon`, `workspace`); none outside a command |
| `DigestLedger.claim` | `packages/domain/src/teams/services.ts:214-223` | "Records that the digest went to a leader, so that it goes out once"; the ledger row and the outbox row "commit together" (`teams/endingSoon.ts:8`, `README.md:81`) | `repositories/teams.ts:786-805` | `teams/endingSoon.ts:174` |
| `AlumniRequests.claim` | `packages/domain/src/personalData/services.ts:69-87` | "One request per person and engagement end"; takes a `Locked<"Person">` token | `repositories/personalData.ts:165-183` | `personalData/commands.ts:408` |

Every production caller already runs in a command that yields `InTransaction` first (`accounts/commands.ts:139, 170, 191, 222, 248, 290, 321`, `contact/commands.ts:25`, `personalData/commands.ts:121, 166, 241, 294, 313, 356, 375`, `teams/commands.ts:123, 223, 265, …`, `teams/endingSoon.ts:154`, `workspace/commands.ts:422, 460`; the chunk's `complete` through `WorkspaceReports.complete`), so no handler changes; `vp check` confirms it. What the omission costs is the alumni and digest flows: the claim, the message and the audit row must commit together, and a claim that commits alone is a message that is never sent, because the key is taken (`ending_soon_digest` and `alumni_request` primary keys, `schema.ts:598-615` and `:317-332`).

Tests that call these ports outside a transaction and must wrap (the type check is the complete list): `packages/db/test/outbox.postgres.test.ts:49-57`, `repositories.pglite.test.ts:376-379, 463`, `teams.pglite.test.ts:511`, `teams.postgres.test.ts:580`; `apps/web/test/alumniDelivery.postgres.test.ts:67`, `deliveryBoundary.postgres.test.ts:212, 239, 315`, `jobs.postgres.test.ts:131`, `outboxQueue.worker.test.ts:162`, `support/commandOutcome.ts:26`. The fakes (`domain/test/support/inMemory.ts`, `teamsInMemory.ts`, `apps/web/test/support/memory.ts`) need no change: a method that requires nothing satisfies a port that requires `InTransaction`.

### B. Found by the sweep of every store port (all 43 `Context.Service` declarations of `packages/domain/src`)

1. **Eighteen methods take a `Locked` token and do not require `InTransaction`** (including `AlumniRequests.claim` above). The token is a run-time proof that the running transaction holds the lock; a method that takes it dies as `LockNotHeld` outside one (`aggregate/locks.ts:55-76`, tested by `aggregates.postgres.test.ts:408`, "even where InTransaction is forged"). So the omission cannot corrupt data, but the type says nothing, and a token is an ordinary value that can leave `Transactor.run` in its result.

   | Port | Methods (declared at) |
   | --- | --- |
   | `AccountRepository` | `findLocked`, `invite`, `transition`, `isLastActiveAdmin`, `verifyEmail` (`accounts/services.ts:27-60`) |
   | `MembershipRepository` | `findLocked`, `listLocked`, `insert`, `setEnd`, `remove` (`teams/services.ts:121-176`) |
   | `AdminGrantRepository` | `create`, `revoke` (`teams/services.ts:192-209`) |
   | `PersonRepository` | `findLocked` (`teams/services.ts:67`) |
   | `CodeRepository` | `replace`, `consume` (`accounts/codeRepository.ts:21-33`) |
   | `ConsentRepository` | `ofLocked`, `record` (`personalData/services.ts:57-65`) |
   | `AlumniRequests` | `claim` (`personalData/services.ts:81-85`) |

   The seven token-taking methods that already require it are `PersonRepository.create`, `AccountRepository.updateProfile`, `WelcomeLedger.claim`, `LegalHolds.of`, `PersonalDataStore.erase`, `.merge` and `.setPhoto`, and `WorkspaceAssignments.assign`.

2. **The documentation contradicts the type.** `packages/domain/src/README.md:79` says `AdminGrantRepository.revoke` "is atomic (it requires `InTransaction`)". Its type (`teams/services.ts:204-209`) has no requirement. Its guarantee is a read of the whole admin list followed by a delete (`repositories/teams.ts:729-752`), which is atomic only under the admin list's lock.
3. **Writes that are complete without a transaction (`Standalone`)**, each one statement or idempotent, so they need not and do not require it: `DepartmentRepository.create`, `.update`; `FieldOfStudyRepository.create`, `.rename`; `SocialEventRepository.create`; `TeamRepository.deactivate`; `SemesterRepository.ensure`; `PublicFileRepository.register`; `JobRuns.claim`, `.release`, `.fail`; `CapturedMessageStore.record`; and all of `OutboxDelivery` but `markDelivered`. The commands that use them are atomic with their audit row because the command requires `InTransaction`, not because the port does.
4. **`OutboxDelivery.markDelivered` is `Joins`.** `accountDelivery.issueCode` calls it inside `Transactor.run` so that the acknowledgement commits with the minted code, and `ack === "claimLost"` fails the run to roll the code back (`apps/web/src/server/accountDelivery.ts:93-159`, the calls at `:101, 114, 155`). Standing alone it commits by itself (`repositories/outbox.ts:224-234`). It cannot require `InTransaction` (spec 0017's one fact for stage 2). No test shows that it joins: `deliveryBoundary.postgres.test.ts:104-108` only interrupts it.
5. **Isolation is a server default, not a statement.** `transactional` calls `sql.withTransaction` with the client's `BEGIN` (`packages/db/src/transactional.ts:48-53`); the level is whatever the server or role default is. It is pinned by one adapter test (`membershipWriteModel.postgres.test.ts:539-552`) and by the skill's table (`verify-membership-writes/SKILL.md:51`). Effect 4.0.6 has `SqlClient.BeginTransaction` for this (`effect/src/sql/SqlClient.ts:735-775`, `@since 4.0.6`).
6. **`InTransaction` is a forgeable proof.** It is exported from the domain and `Effect.provideService(program, InTransaction, …)` type-checks anywhere. Today it is provided in `packages/db/src/transactional.ts:24, 51`, in the test compositions (`apps/web/test/support/memory.ts:575`, `packages/domain/test/support/inMemory.ts:409`) and in the forgery test (`aggregates.postgres.test.ts:419`). Only locks refuse a forged proof at run time.

### C. The domain's contract text that states a mechanism (ADR section 1, last rows)

Twenty-one occurrences of engine vocabulary in `packages/domain/src` (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `ON CONFLICT`, `RETURNING`, `jsonb`, `savepoint`, "exclusion constraint", "Postgres", "PostgreSQL", `SQL`):

| File:line | Text |
| --- | --- |
| `accounts/services.ts:40` | `UPDATE … SET state = to WHERE person = $locked AND state = ANY(from)` |
| `files/services.ts:1, 19` | "(Postgres)"; `ON CONFLICT (key) DO NOTHING` |
| `jobs/runs.ts:6` | `INSERT … ON CONFLICT DO NOTHING` |
| `kernel/machine.ts:6` | `UPDATE … SET state = to WHERE id = $1 AND state = from` |
| `organisation/commands.ts:96`, `organisation/services.ts:44` | `INSERT … ON CONFLICT … RETURNING` |
| `outbox/delivery.ts:9` | "one conditional `UPDATE … RETURNING`" |
| `shared/aggregate.ts:18, 54, 67` | `SELECT … FOR NO KEY UPDATE`; "savepoint" |
| `shared/ids.ts:4`, `shared/outbox.ts:45` | "PostgreSQL identity columns"; "Persisted as jsonb" |
| `teams/services.ts:143, 151, 166` | "the database's exclusion constraint"; `UPDATE … WHERE …`; `DELETE … WHERE …` |
| `personalData/catalog.ts:20`, `declaration.ts:51, 93, 174`, `alumni.ts:14` | the catalog's table names, its SQL expressions and `jsonb` paths (data, not guarantees) |

The last row's five stay (stage 5 declares data ownership; ADR answer 3 moves the retention arithmetic into Effect). The other sixteen are reworded. `packages/domain/src/README.md` (lines 7-22, the transaction sketch over the SQL client; 76-81, the repository contract's `UPDATE`, `DELETE` and `INSERT` forms and the digest claim) follows.

### D. Snapshot assumptions

| Port method | What it reads | The assumption today | Evidence |
| --- | --- | --- | --- |
| `PersonalDataStore.exportOf` (`personalData/services.ts:118-122`) | every row that names the person, across the catalog's tables | "One snapshot": one statement, so a write that commits during the export is in all tables or none (`packages/db/src/personalData/export.ts:1-5, 44-58`). The port takes no `InTransaction`, and the command that calls it holds one (`personalData/commands.ts:294`), but READ COMMITTED gives no snapshot across statements, so the snapshot must be made by the method | none for tearing: `personalDataExport.postgres.test.ts`'s control (`:193`) checks the person filter, not the snapshot |
| `PrincipalDirectory.activeById`, `byName` (`teams/services.ts:236-250`) | account state, memberships active in a semester, the end of every admin place | "One read": one statement (`repositories/teams.ts:842-923`). The principal is as of that instant and is not refreshed for the request | `adminList.postgres.test.ts:423` (a stale principal can neither revoke nor deactivate the last Active administrator) |
| `OutboxReports.overview` (`outbox/status.ts:67-72`) | counts and the newest open rows | "Two reads, not one snapshot" (`repositories/outbox.ts:371-375`): stated in the adapter, nowhere in the domain | none needed: it is a status |
| `WorkspaceFacts.*`, `WorkspaceReports.read`, `.latest` (`workspace/services.ts:104-128, 170-174`) | the projection's inputs, one method each | "Read the way a display reads: no lock, no write" (`:104`); two methods share no snapshot | none needed |

## What `InTransaction` promises

One declaration, with these as separate guarantees (ids in the catalogue): **TX1** atomic visibility, rollback on typed failure, defect and interruption, success means committed; **TX2** a nested scope undoes only its own writes and releases only its own locks; **TX3** the isolation floor, named **ReadCommittedWithLocks**: no read sees an uncommitted write of another transaction, and a read made after a lock on a record returns the record as of the grant of the lock or later (so a decision read through a token sees the latest committed state), and **nothing is promised across two reads of unlocked records**: they may differ, so a program that needs one state reads it in one call (`exportOf`, `PrincipalDirectory`) or locks; a stronger isolation level satisfies it and is allowed; **TX4** a deadlock or serialization failure is a defect and is never retried, and the lock order (LK2) is what keeps it from arising; **TX5** the proof is provided only by a `Transactor`. Provider I/O inside a transaction is a convention that nothing checks (mode `Outside`); the spec records it as such and claims no strength for it.

## The guarantees

The declaration `StoreGuarantees` (`packages/domain/src/shared/guarantees.ts`, new) holds one row per line below: `id`, `capability` (the closed set of ADR decision 1), `property` (the sentence, store-neutral), `strength`, `invariant`, `carriers` (port methods, each referenced by the class and a method name that the type checks) and `rawWriter` (the stage 3 case that shows the strength: what the raw writer tries). The port comments, `docs/system/store-guarantees.md` and the contract suites derive from it. **A property here is the sentence, not the mechanism**; today's mechanism is given only as evidence, and stays in `packages/db`.

| Id | Property | Strength | Inv. | Carriers | Evidence today (stage 3 extracts it) |
| --- | --- | --- | --- | --- | --- |
| **TX1** | All writes made in one transaction become visible to other transactions together, or none do. A typed failure, a defect or an interruption of the program leaves none. `run` succeeding means committed. | store | no | `Transactor.run` | `transactions.postgres.test.ts:104-165`; control `jobRuns.postgres.test.ts` (a cursor committed apart from its chunk) |
| **TX2** | A nested scope undoes its own writes when it fails and releases the locks it took; when it succeeds it hands both to the enclosing scope. | store | no | `Transactor.run` | `transactions.postgres.test.ts:167`; `aggregates.postgres.test.ts:511` |
| **TX3** | The isolation floor ReadCommittedWithLocks (above). | store | no | `InTransaction` | `membershipWriteModel.postgres.test.ts:539`; new, falsifier 4 |
| **TX4** | A deadlock or serialization failure is a defect and is never retried. | port | no | `Transactor.run`, `AggregateLocks.lock`, `.lockAll` | `aggregates.postgres.test.ts:113` (300 rounds, none), control `:144` (by hand: deadlocks) |
| **TX5** | `InTransaction` is provided only by a `Transactor` or by a test composition that keeps TX1 to TX3. | port | no | `InTransaction` | new, falsifier 6 |
| **LK1** | At most one transaction holds the lock of a root's record at a time; a second request for it waits until the first ends. | port | no | `AggregateLocks.lock`, `.lockAll` | `aggregates.postgres.test.ts:184` and `adminList.postgres.test.ts:374`; the waiting is read from the backend (`test/support/race.ts`) |
| **LK2** | Locks are taken in one order: the roots in `AggregateRoots` order, the records of a root in ascending id. A request that would break it is a defect at its first run, so lockers cannot wait on each other in a cycle. | port | no | `AggregateLocks.lock`, `.lockAll` | `aggregates.postgres.test.ts:113, 144, 304, 353` |
| **LK3** | A token is good only in the transaction that holds the lock of its record, for its root; any other use is a defect and never reads or writes. Locking a record already held returns the same token and takes nothing. | port | no | `AggregateLocks`; every token-taking method | `aggregates.postgres.test.ts:408, 430, 511` |
| **LK4** | A record that has been merged away cannot be locked (`NotFound`), and a lock that waited for the merge observes it. | port | no | `AggregateLocks.lock`, `.lockAll` | `personalDataMergeRace.postgres.test.ts` (300 rounds), `SKILL.md:70` |
| **LK5** | A record that a root owns is written only through the root's token; a stored machine's state changes only through the machine's transitions. | port | no | `MembershipRepository.insert`, `.setEnd`, `.remove`; `AdminGrantRepository.create`; `AccountRepository.transition`; `CodeRepository.replace`; `ConsentRepository.record` | types (`aggregate.types.test.ts`), the lint rule `no-owned-table-write`, `aggregates.postgres.test.ts:615` |
| **LK6** | Exactly one admin-list record exists. | store | yes | `AggregateLocks.lock` | migrations `admin_list`, `admin_list_seeded`; `adminList.postgres.test.ts` |
| **LK7** | At least one Active administrator with a valid place remains after every deactivation, reactivation, grant and revocation: decided under the admin list's lock, on every administrator at once. **A rule about which commands may commit, not an invariant:** a place expires with time, so no state predicate can hold at all times and the store cannot enforce it. (ADR answer 2 binds invariants; this is recorded so that it is not read as an exception.) | port | no | `AccountRepository.isLastActiveAdmin`, `AdminGrantRepository.revoke`, `.create` | `adminList.postgres.test.ts:374, 388`; control `:402` (each person's lock only: no Active administrator in all rounds) |
| **UK1** | At most one record per natural key: department city; person e-mail and company e-mail; team name within its department and team group e-mail; semester (term, year); public file key and legacy path; position name; one-time code hash; company address; captured delivery key. | store | yes | `DepartmentRepository.create`, `.update`; `TeamRepository.create`, `.update`; `PersonRepository.create`; `AccountRepository.updateProfile`; `SemesterRepository.ensure`; `PublicFileRepository.register`; `WorkspaceAssignments.assign`; `CodeRepository.replace`; `CapturedMessageStore.record` | `teams.postgres.test.ts` (names, addresses), `concurrency.postgres.test.ts:60`; control `:87` |
| **UK2** | A write refused for a duplicate key fails with `AlreadyExists` carrying the entity and the key, never as a defect. | port | no | the carriers of UK1 | `classifySqlFailure.test.ts`, `commands.postgres.test.ts` |
| **UK3** | Find-or-create (`ensure`, `register`): concurrent callers all receive the one record; a repeat changes nothing. | store | no | `SemesterRepository.ensure`, `PublicFileRepository.register` | `concurrency.postgres.test.ts:60` (20 callers, one record); control `:87` |
| **NO1** | One person's memberships in one team never overlap (closed ranges of semester ordinals; a term that starts the semester after another ends does not overlap it). | store | yes | `MembershipRepository.insert`, `.setEnd` | `teams.postgres.test.ts:621-653` (falsifier 4: refused, and with the rule dropped the overlap gets in: the control) |
| **NO2** | A membership's start is not after its end; the ordinals follow the term. | store | yes | `MembershipRepository.insert`, `.setEnd` | `teams.postgres.test.ts:621` (falsifier 4: "the constraints hold in the database") |
| **NO3** | Of two concurrent writes that overlap, exactly one commits and the other fails with `AlreadyExists`, never with a deadlock. | port | no | `MembershipRepository.insert`, `.setEnd` | `teams.postgres.test.ts:452` (two overlapping inserts at once) and its 300-round guards; the model (`SKILL.md:161`) |
| **CW1** | A write that depends on a record's state is judged against its newest committed state when it takes effect: if the expected state no longer holds, nothing is written and the caller gets `Conflict`. Of two concurrent transitions from one state, exactly one wins. | port | no | `AccountRepository.transition`; `MembershipRepository.setEnd`, `.remove` | `aggregates.postgres.test.ts:184` (300 rounds); control `:257` (an unconditional write: both win, every round) |
| **CW2** | A replace never rewrites another owner's record, and replaces the owner's own. | port | no | `CodeRepository.replace`, `ConsentRepository.record` | `aggregates.postgres.test.ts:657` |
| **CL1** | At most one claim per key: the first-membership welcome per person; the ending-soon digest per person and semester; the alumni request per person and engagement end; a job's run per job and period; a company address; a captured message per delivery key. | store | yes | `WelcomeLedger.claim`, `DigestLedger.claim`, `AlumniRequests.claim`, `JobRuns.claim`, `WorkspaceAssignments.assign`, `CapturedMessageStore.record` | `welcome.postgres.test.ts`, `teams.postgres.test.ts` (digest), `personalDataAlumni.postgres.test.ts`, `jobRuns.postgres.test.ts`, `accounts.postgres.test.ts` (300 × 20) |
| **CL2** | Of concurrent callers of one key, exactly one is told it made the claim; the others are told it was taken. | port | no | the carriers of CL1 | the same tests; controls `welcome.postgres.test.ts`, `jobRuns.postgres.test.ts` |
| **CL3** | A claim commits with the writes it guards: the claim, the message queued for it and its audit row become visible together or not at all. A claim that commits alone is a message never sent. | port | no | `WelcomeLedger.claim`, `DigestLedger.claim`, `AlumniRequests.claim`, `Outbox.enqueue`, `AuditLog.record` | **new: the type of the four ports (falsifier 1)**; `welcome.postgres.test.ts` |
| **LS1** | A pending outbox record has at most one live claim; of any number of claimers, exactly one holds it. A duplicate message finds it `Held` or `Settled` and never sends twice. | port | no | `OutboxDelivery.claim` | `outbox.postgres.test.ts:94` (20 claimers, 300 rounds) |
| **LS2** | An acknowledgement or release that carries a claim token other than the record's current one changes nothing and reports `claimLost`. | port | no | `OutboxDelivery.markDelivered`, `.markFailed` | `outbox.postgres.test.ts`, `repositories.pglite.test.ts:430-438` |
| **LS3** | Delivery is at least once, with no order across records; a provider can hear of a record twice when its send succeeded and the acknowledgement did not commit. | port | no | `OutboxDelivery` | `deliveryBoundary.postgres.test.ts:104` |
| **LS4** | `markDelivered` is one conditional write that joins the caller's transaction when there is one (the acknowledgement then commits or rolls back with the caller's writes) and commits alone otherwise. Which of the two holds is the caller's, and the port neither requires nor reports it. | port | no | `OutboxDelivery.markDelivered` | **new: falsifier 5** |
| **LS5** | The queue's receipt (`markQueued`) is recorded only for pending records; `stale` lists pending records with no live claim whose last receipt or next attempt is not after the cut-off; a dead ending is recorded only after a failure class was recorded. | port | no | `OutboxDelivery.markQueued`, `.stale`, `.markDead`, `.recordFailure` | `outbox.postgres.test.ts` |
| **LS6** | A job's period has one runner: a claim never waits; a runner whose period was taken over writes nothing (`LeaseLost`); a chunk's rows and its cursor commit together. | port | no | `JobRuns.claim`, `.advance`, `.finish`, `.release`, `.fail` | `jobRuns.postgres.test.ts:293` (and `:252`, control: a cursor committed apart from its chunk) |
| **SN1** | The export of one person reflects one committed state: no transaction's effects appear in part. It writes nothing and takes no lock. The method makes the snapshot itself, because its caller's transaction gives none (TX3). | store | no | `PersonalDataStore.exportOf` | **untested today** (see D): new in stage 3, control a two-read export that a concurrent merge tears |
| **SN2** | A person's principal (account state, memberships active in a given semester, the end of every admin place) is as of one committed state at the instant of the read, and is not refreshed during the request. A decision that must hold against later change does not rest on it: it is decided again under a lock (LK1, CW1, LK7). | store | no | `PrincipalDirectory.activeById`, `.byName` | `adminList.postgres.test.ts:423` |
| **SN3** | No snapshot is promised across separate reads: `OutboxReports.overview`, `WorkspaceFacts` and `WorkspaceReports.read`/`.latest` may each show a state that no single instant held. | (a non-guarantee) | no | those methods | by comment today |
| **RR1** | A read writes nothing and takes no lock. | port | no | every `Read` method | `readOnlyRole.postgres.test.ts`, `apps/web/test/readsNeverWrite.postgres.test.ts` (a role that holds `SELECT` only; production runs under the full role) |
| **RT1** | A retention run at one instant is idempotent: a second run at the same instant changes nothing. A record expires when its period, counted in Oslo calendar time from its trigger, has passed `now`. The mode (`Apply` or `ReportOnly`) is fixed by the layer: a program cannot choose it. | port | no | `RetentionRun.run` | `retention.postgres.test.ts:153, 250`, `retentionGate.postgres.test.ts` |
| **ER1** | An erasure of one person applies each table's declared expiry and keeps the rows of a table that is `Kept`; a second call changes nothing. A merge moves every row of one person to another by the catalog's rules and makes the first a tombstone, or fails with `Conflict` and changes nothing. | port | no | `PersonalDataStore.erase`, `.merge` | `personalDataErasure`, `personalDataMerge` (`:381`, 20 × 300), `personalDataMergeRace` (300 rounds) |
| **OS1** | `put` of one content-addressed key is idempotent: a repeat leaves the same object. | port | no | `FileStore.put` | `apps/web` file tests |

`AnalyticsReads` is in ADR decision 1's list and has no carrier at `336fcde` (stage 6 adds one), so it has no row; the capability set is closed with it in, so a later row needs no type change. Two ADR answers have no row: answer 3 (retention arithmetic in Effect) names no stage in the staged plan (see [Resolutions](#resolutions-of-the-open-questions)), and answer 5 (one model of the abstract guarantees) is out of scope.

## Transaction modes

`TransactionModes` (`packages/domain/src/shared/transactionModes.ts`, new) is one declaration of the mode of every method of every store port. Its type is an exhaustive mapped type over the ports and their methods: a method without a row, and a row without a method, are compile errors. Rules:

1. **Every method that takes a `Locked` token is `Requires`.** A token is good only in the transaction that holds it (LK3); the type says so. Eighteen methods change (inventory B1, one of which is `AlumniRequests.claim` of A), and with `Outbox.enqueue`, `AuditLog.record` and `DigestLedger.claim` that is 21 in all.
2. **A claim, an enqueue or an audit write is `Requires`** (CL3): `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim`, `AlumniRequests.claim`, `WelcomeLedger.claim` (already).
3. **A method that is complete as one statement is `Standalone`** (inventory B3), and its guarantee names why.
4. **`OutboxDelivery.markDelivered` is `Joins`** (LS4); a method that opens its own transaction is `Opens` (`Transactor.run`, `ImportTarget.replaceAll`); provider I/O is `Outside` (`FileStore`, `WorkspaceDirectory`, `WorkspaceWriter`).
5. **A service that is not a store port** (`Info`, `CurrentPrincipal`, `PasswordHasher`, `SiteOrigin`, `InTransaction`) is listed in `NotStorePorts` with its reason, so a scan of `Context.Service` classes finds none that is in neither list.

`AuditLog.latest` and every `list`, `find`, `of`, `byPerson`, `names` and similar are `Read`.

## Falsifiers (each with a negative control)

1. **The ADR's falsifier: calling `Outbox.enqueue`, `AuditLog.record`, `DigestLedger.claim` or `AlumniRequests.claim` outside a transaction fails the type check.** `packages/domain/test/shared/transactionRequired.test.ts`, in the style of `transactor.test.ts` and with no `@ts-expect-error`: for each of the 21 methods, a program that calls it has `InTransaction` in `Effect.Services<…>` and is not assignable to a program that needs only its port; the same program through `Transactor.run` has no `InTransaction`. `vp check` is what fails (as for `transactor.test.ts`). **Controls:** (a) a method that stays standalone (`OutboxDelivery.markQueued`, `JobRuns.claim`) shows no `InTransaction`, so the test tells the two apart; (b) mutation: delete `InTransaction` from `Outbox.enqueue`'s signature, then from each of the others (21 runs, each restored): `vp check` fails at that method's case every time.
2. **Every store-port method has a mode, and the type agrees with it.** `transactionModes.test.ts` (types): the declaration is exhaustive (**control:** delete one row, then add a method to a port without one: compile error both times); each row's mode is checked against the method's requirements (`Requires` ⇒ `InTransaction` is required; `Standalone`, `Joins`, `Read`, `Outside` ⇒ it is not) (**control:** flip one row: compile error); every method with a `Locked` parameter is `Requires` (**control:** a fixture port with a token-taking method that requires nothing fails the same check). A source scan finds every `Context.Service` class of `packages/domain/src` in `TransactionModes` or `NotStorePorts` (**control:** a new class in neither fails; an entry of `NotStorePorts` that is no class fails, so the list cannot rot).
3. **The declaration holds together.** Ids are unique; every carrier names a method that exists (typed); every guarantee with `invariant: true` is `store-enforced` (**control:** a fixture declaring a port-enforced invariant fails the same check, so the check is not vacuous); every guarantee has a non-empty `rawWriter`; every carrier of a guarantee that claims a transaction (CL3, LS6) is `Requires` in `TransactionModes` where the guarantee says so.
4. **The isolation floor is a statement, not a server default.** `packages/db/test/isolation.postgres.test.ts` (and the same on PGlite, `repositories.pglite.test.ts`): on a disposable database whose role has `default_transaction_isolation = 'serializable'`, a program under `transactional` reads `current_setting('transaction_isolation')` as `read committed`, in a top-level scope and in a nested one (a savepoint keeps its parent's level). **Control:** the same program through a plain `sql.withTransaction` reads `serializable`, so the role setting is in force and the test would see a transaction that left the level alone. The existing pin (`membershipWriteModel.postgres.test.ts:539-552`) stays. [INFERENCE: PGlite accepts `BEGIN ISOLATION LEVEL READ COMMITTED`; the case shows it. Hyperdrive in transaction-pooling mode passes a `BEGIN` variant, not a session `SET`; the deployed check is a follow-up, see Out of scope.]
5. **`markDelivered` joins the caller's transaction.** A db-level case: inside `Transactor.run`, `markDelivered` followed by a typed failure leaves the record pending with its claim intact (the acknowledgement rolled back); the same two steps outside `run` leave it delivered. **Controls:** (a) the contrast is the second half of the case; (b) mutation: build `OutboxDeliveryLive` over a pool other than `Transactor`'s: the acknowledgement commits while the outer transaction rolls back, and the case fails (spec 0017 R14 is why a second client does not join).
6. **The proof is not forged.** `tools/quality/test/inTransactionProviders.test.ts` (a source test in the style of `authPool.test.ts`): `InTransaction` is provided (`provideService`, `Layer.succeed`, `InTransaction.of`) only in `packages/db/src/transactional.ts` and in the files of one allowlist of test compositions, each with its reason; an allowance that no file needs fails, so the list only shrinks. **Controls:** a provider added to `apps/web/src/server/runtime.ts` fails; a stale allowance fails.
7. **The domain states properties, not mechanisms.** `packages/domain/test/shared/mechanismWords.test.ts` (source scan): no occurrence of the engine vocabulary of inventory C in `packages/domain/src` outside five allowed lines of the personal data catalog, each with its retirement (stage 5, ADR answer 3). **Controls:** writing `ON CONFLICT` into a port comment fails; removing an allowed line's text makes its allowance stale and fails.
8. **No behaviour change.** `bun run test:all` passes with every assertion untouched: a reviewer reads each test file's diff and finds only wrapped calls (inventory A) and the new cases. The controls of the suites that cover the touched ports still fail without their mechanism: the claim-by-id mutation of spec 0017 falsifier 4 (`outbox.postgres.test.ts:94`, `outboxQueue.postgres.test.ts`) and a rollback that is taken out (`transactions.postgres.test.ts:104-165`), each run once. `bun run description` changes no file under `packages/domain/conformance`. The membership-writes model (`devenv shell --profile formal -- .agents/skills/verify-membership-writes/run.sh`) runs on the commits that touch its covered files (`shared/aggregate.ts`, `transactional.ts`, `shared/transactor.ts`) and reports no drift.
9. **The generated document matches the declaration.** `bun run check:docs` fails when `docs/system/store-guarantees.md` differs from `StoreGuarantees`. **Controls:** the docgen tests change one generated character, then remove one guarantee without regenerating: both fail.

**Latency report (not a falsifier).** One command (`createMembership`) on PostgreSQL, 100 timed after 20 warmups, interleaved, main against the branch: p50 and p95, flagged above 500 ms. [INFERENCE: the explicit `BEGIN ISOLATION LEVEL` is the same round trip as `BEGIN`; the types add no statement. Measure to confirm.]

## Migration order

Every step is one commit whose subject is a lowercase Conventional Commit and passes `devenv shell -- bunx vp check` plus the tests of the packages it touches. The two signature steps change callers and tests in the same commit, so none is red.

| # | Commit | Gate beyond `vp check` |
| --- | --- | --- |
| 0 | `docs(spec): store guarantees as properties (adr 0014 stage 2)`: this file | none |
| 1 | `feat(domain): declare the store guarantees as data`: `shared/guarantees.ts` (`Capability`, `Strength`, `Guarantee`, the typed `carrier`, `StoreGuarantees`), the `InTransaction` comment states TX1 to TX5, index export | falsifier 3 |
| 2 | `refactor(domain): state the store ports as properties`: the sixteen reworded lines of inventory C, each port comment that states a guarantee refers to its id, `README.md`; the scan and its five allowances | falsifier 7; the model run (`shared/aggregate.ts` is covered) |
| 3 | `feat(domain): declare every store port's transaction mode`: `TransactionModes` and `NotStorePorts` with **today's** modes (the 21 methods are `Standalone` or `Read` for now), the type test and the scan | falsifier 2 |
| 4 | `refactor(domain): require a transaction of the claim, the outbox and the audit log`: the four methods change, their rows become `Requires`, the 12 test sites of inventory A are wrapped, `transactionRequired.test.ts` for the four | falsifier 1 (the four) |
| 5 | `refactor(domain): require a transaction of every method that takes a lock token`: the 17 methods of B1, `README.md:79` becomes true, their rows change, the cases for them | falsifier 1 (all 21); falsifier 2's token rule |
| 6 | `refactor(db): begin every transaction at read committed`: `transactional` provides `SqlClient.BeginTransaction` with `BEGIN ISOLATION LEVEL READ COMMITTED` around its `withTransaction`; the isolation cases | falsifier 4; the model run (`transactional.ts` is covered) |
| 7 | `test(db): markDelivered joins the caller's transaction`: the case and its mutation | falsifier 5 |
| 8 | `build(quality): fail a second provider of InTransaction`: the source test and its allowlist | falsifier 6 |
| 9 | `docs(system): generate the store guarantees`: the docgen block and `docs/system/store-guarantees.md` | falsifier 9; `bun run check:docs` |
| 10 | `docs: record that the store guarantees are properties`: `AGENTS.md` (the database rule and the architecture list), `packages/db/README.md`, `packages/domain/src/README.md`, ADR 0014's stage 2 row ("done by spec 0018"), `STATE.md` | `bun run check:docs` |

Final gate before the PR: `devenv shell -- bun run ready`, then the latency report. A pre-push hook runs `bun run test:all` and needs `devenv up -d && devenv processes wait`; run `devenv down` afterwards. Steps 4 and 5 may land as one PR with 1 to 3, or step 5 may be cut (see Resolutions 1).

## Out of scope

- **Stages 3 to 6:** the contract suites and their broken variants (every `rawWriter` case, the torn-export case of SN1), the PGlite runs of them, the in-memory adapter and the deletion of the ad-hoc fakes (they need no change here), data-ownership declarations, a second store.
- **Capability services** (`Claims`, `UniqueKeys`, …) as Effect services that replace the ports; `Transactions` replacing `SqlClient` in the apps; dropping `SqlClient` from `DatabaseLive`'s output (spec 0017, F).
- **A run-time refusal of a forged `InTransaction`** by every writing adapter. Locks refuse it already (`aggregates.postgres.test.ts:408`); falsifier 6 keeps the proof from being provided elsewhere, which is the cheaper construction.
- **Making "no provider I/O inside a transaction" structural.** The type system has no "forbids" requirement; the mode `Outside` records the convention and nothing checks it.
- **Moving the retention arithmetic into Effect** (ADR answer 3) and the property test against `person_last_activity_end`: the staged plan gives it no stage (see Resolutions 6).
- **The importer as a raw writer of the invariants** (a stage 3 case: `ImportTarget` over a database whose invariants it would break).
- **The deployed check of the explicit `BEGIN`** on Hyperdrive and Neon (slice 0000's harness, `tools/db-path-spike`).
- **The TLA+ model of the abstract guarantees** (ADR answer 5), the lint rule's and `ownership.ts`'s coupling to the adapter (stage 5), EmDash and `apps/cms`.

## Resolutions of the open questions

Proposals this spec builds. Each is one declaration or one sentence the operator can overrule by changing that one place.

1. **The token rule (inventory B1, 17 methods) is included, and cuttable.** The ADR names four ports and "any other port the stage-1 inventory found with a silent transaction assumption". The sweep found 17 more, covered at run time by the token. Included because a token can leave `Transactor.run` in a result, because `README.md:79` already misreads the convention (it says `revoke` requires `InTransaction`), and because every caller is already inside a transaction. If cut: step 5, rule 1 of the modes and the token clause of falsifier 2 go, and nothing else changes.
2. **`BEGIN ISOLATION LEVEL READ COMMITTED` is explicit** (falsifier 4), because a role-level `default_transaction_isolation` would otherwise move every transaction to a level whose serialization failures nobody retries. If the deployed platform refuses it, the fallback is the existing pin test plus a startup assertion; the property text does not change.
3. **The last-administrator rule is `invariant: false`** (LK7), for the reason in its row. If the operator wants it store-enforced anyway, the adapter needs a deferred trigger on the account and place tables, which time still defeats; that is a new ADR question.
4. **Strength is decided by the raw-writer question** (Vocabulary), so that "store-enforced" and "port-enforced" are tests and not opinions. A read property is `store-enforced`; SN3 is a non-guarantee and carries no strength.
5. **The guarantees are generated into `docs/system/store-guarantees.md`** (step 9), so there is one home. It can be dropped without touching the declaration.
6. **ADR answer 3 (retention arithmetic in Effect) has no stage in the staged plan.** Stage 2 states only RT1. The lead may schedule it as its own spec; until then `personalData/alumni.ts:14` and `declaration.ts:51, 93` stay on the allowance list of falsifier 7.
7. **`ObjectStore` has one row (OS1)**; "never inside a transaction" is a convention, not a guarantee.
8. **The number 0018 is the next free.** `docs/specs/` holds 0017 as its highest at `336fcde`, and no branch of the remote holds a 0018.

## Checks the build runs and reports

`devenv shell -- bunx vp check` (format, lint, type check with the Effect diagnostics, which is also where falsifiers 1 to 3 fail), `bun run test:all`, `bun run check:docs`, `bun run check:store-boundary`, `bun run check:exceptions` (no new suppression is planned: the type tests use no `@ts-expect-error`), the knip step of `bun run ready`, the membership-writes model on its covered files, and the mutations of falsifiers 1, 4, 5 and 8 each run once and restored. There is no `effect-house` overlay in this repository (`.agents/skills/` holds `review-pr`, `verify-membership-writes` and `verify-vektorprogrammet`), so `AGENTS.md` names the gates. The build is against Effect 4.0.6; the report names every API for which installed guidance had no entry: `SqlClient.BeginTransaction` has JSDoc and an example in `effect/src/sql/SqlClient.ts:735-775` and none in `ai-docs`; `Effect.Services` (`effect/src/Effect.ts:223`) has none in `ai-docs` either.

## Revisions

Entries written while building, dated, in the order of the commits. Each says what the build did differently from the text above and why. None yet.
