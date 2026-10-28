# Store guarantees

What the domain asks of a store, written as properties of an abstract store: records, keys, transactions and committed state. No statement, no table and no engine feature appears in a property; an adapter keeps each one in its own way (ADR 0014, spec 0018).

The page is generated from `packages/domain/src/shared/guarantees.ts` (the guarantees) and `packages/domain/src/shared/transactionModes.ts` (what each port method asks of a transaction): run `bun run docs` after changing either. CI runs `bun run check:docs`.

## How to read it

- **Strength.** `store-enforced`: the property holds against every writer, including the importer and a migration. `port-enforced`: it holds only against writers that use the port. The question that decides it: can a writer that writes valid data straight into the store, without the port, make the property false for a program that uses the port? Each row says in its last column what that writer tries.
- **Invariant.** A predicate of one committed state (at most one record per key). The invariants are store-enforced (ADR 0014, answer 2), except one that the store cannot express, with a named exception: the last administrator (LK7), whose validity depends on time. Its recovery is the `Emergency` principal of ADR 0011.
- **In a transaction.** A carrier marked so is one whose writes the guarantee spans (CL3, LS6): its type requires `InTransaction`, and the declaration is checked against the transaction modes below.
- **Isolation.** TX3 below is the floor that `InTransaction` promises (ReadCommittedWithLocks); a stronger level is allowed. The PostgreSQL adapter begins each `Transactor.run` transaction, and the importer's one, at READ COMMITTED, stated in the statement that begins it. A statement that runs outside a transaction (a `Standalone` or `Joins` method used alone) runs at the role's default, which must be READ COMMITTED. That default is asserted for the test server and for every pull request's Preview; production answers nothing there, so it is not asserted for production until it is deployed (spec 0018 R9, R10, R18).
- **Transaction mode.** `Requires`: the method's type requires `InTransaction`, because its guarantee spans writes or rests on a lock. `Standalone`: complete as one atomic step. `Joins`: one conditional write that commits with the caller's transaction when there is one. `Read`: writes nothing and takes no lock. `Outside`: provider I/O, never inside a transaction (a convention that nothing checks). `Opens`: opens its own transaction.

## Guarantees

<!-- docgen:begin guarantees -->

### Transactions

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| TX1 | All writes made in one transaction become visible to other transactions together, or none do. A typed failure, a defect or an interruption of the program leaves none. `run` succeeding means committed. | store-enforced | no | `Transactor.run` | writes outside a transaction while one is open: the other transaction's writes still appear together or not at all |
| TX2 | A nested scope undoes its own writes when it fails and releases the locks it took; when it succeeds it hands both to the enclosing scope. | store-enforced | no | `Transactor.run` | writes during a nested scope that fails: the enclosing scope's own writes survive |
| TX3 | The isolation floor ReadCommittedWithLocks: no read sees another transaction's uncommitted write; a read made after a lock on a record returns the record as of the grant of the lock or later, so a decision read through a token sees the latest committed state. Nothing is promised across two reads of unlocked records: they may differ, so a program that needs one state reads it in one call or locks. A stronger isolation level satisfies it and is allowed. | store-enforced | no | `InTransaction` | commits a change to a locked record while another transaction waits for the lock: the waiter reads the new state |
| TX4 | A deadlock or a serialization failure is a defect and is never retried; the lock order (LK2) is what keeps it from arising. | port-enforced | no | `Transactor.run`, `AggregateLocks.lock`, `AggregateLocks.lockAll` | locks the same records in the opposite order by hand: it deadlocks with a port user, which is why the order is a rule of the port |
| TX5 | `InTransaction` is provided only by a `Transactor`, or by a test composition that keeps TX1 to TX3; a program that holds it runs inside such a scope. A store adapter checks, before the first statement of a method that requires it, that the proof the program holds is the live transaction's own, and refuses one that is not: a proof made by hand, one used after its transaction ended, in another transaction, or where a nested scope runs. | port-enforced | no | `InTransaction` | makes a proof by hand (Effect keys a service by a string, so it can be made without naming the service), keeps one past its transaction, or carries it into another: a program that uses the port is refused at first use and writes nothing; a writer that does not use the port is not asked for a proof at all |

### AggregateLocks

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| LK1 | At most one transaction holds the lock of a root's record at a time; a second request for it waits until the first ends. | port-enforced | no | `AggregateLocks.lock`, `AggregateLocks.lockAll` | writes the record without asking for its lock: the write goes through while another transaction holds it |
| LK2 | Locks are taken in one order: the roots in `AggregateRoots` order, the records of a root in ascending id. A request that would break the order is a defect found at its first run, so lockers cannot wait on each other in a cycle. | port-enforced | no | `AggregateLocks.lock`, `AggregateLocks.lockAll` | takes two locks in descending order: it deadlocks with a port user in each round |
| LK3 | A token is good only in the transaction that holds the lock of its record, for its root; any other use is a defect and never reads or writes. Locking a record already held returns the same token and takes nothing. | port-enforced | no | `AggregateLocks.lock`, `AggregateLocks.lockAll` | makes a token by hand or keeps one from a finished transaction: the port refuses it, the store would not |
| LK4 | A record that has been merged away cannot be locked (`NotFound`), and a lock that waited for the merge observes it. | port-enforced | no | `AggregateLocks.lock`, `AggregateLocks.lockAll` | writes through a lock request that bypasses the port's check for merged records |
| LK5 | A record that a root owns is written only through the root's token; a stored machine's state changes only through the machine's transitions. | port-enforced | no | `MembershipRepository.insert`, `MembershipRepository.setEnd`, `MembershipRepository.remove`, `AdminGrantRepository.create`, `AccountRepository.transition`, `CodeRepository.replace`, `ConsentRepository.record` | writes an owned record or a machine's state directly: it succeeds, and only the types and the lint rule refuse it |
| LK6 | Exactly one admin-list record exists. | store-enforced | yes | `AggregateLocks.lock` | inserts a second admin-list record or deletes the one: refused |
| LK7 | At least one Active administrator with a valid place remains after every deactivation, reactivation, grant and revocation: decided under the admin list's lock, on every administrator at once. No importer and no migration removes the last Active administrator. | port-enforced; exception: validity depends on time (recovery: the Emergency principal of ADR 0011 (Emergency access) restores admin access out of band) | yes | `AccountRepository.isLastActiveAdmin`, `AdminGrantRepository.revoke`, `AdminGrantRepository.create` | deactivates the last Active administrator's account directly: it succeeds (a place also lapses with time, so no stored-row predicate can hold it) |

### UniqueKeys

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| UK1 | At most one record per natural key: department city; person e-mail and company e-mail; team name within its department and team group e-mail; semester (term, year); public file key and legacy path; position name; one-time code hash; company address; captured delivery key. | store-enforced | yes | `DepartmentRepository.create`, `DepartmentRepository.update`, `TeamRepository.create`, `TeamRepository.update`, `PersonRepository.create`, `AccountRepository.updateProfile`, `SemesterRepository.ensure`, `PublicFileRepository.register`, `WorkspaceAssignments.assign`, `CodeRepository.replace`, `CapturedMessageStore.record` | inserts a second record with the same key: refused |
| UK2 | A write refused for a duplicate key fails with `AlreadyExists` carrying the entity and the key, never as a defect. | port-enforced | no | `DepartmentRepository.create`, `TeamRepository.create`, `PersonRepository.create`, `WorkspaceAssignments.assign` | gets the store's own refusal, with no entity and no key: the port is what names them |
| UK3 | Find-or-create: concurrent callers all receive the one record; a repeat changes nothing. | store-enforced | no | `SemesterRepository.ensure`, `PublicFileRepository.register` | inserts the record first: the caller receives that record and no second one exists |

### NonOverlap

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| NO1 | One person's memberships in one team never overlap (closed ranges of semester ordinals; a term that starts the semester after another ends does not overlap it). | store-enforced | yes | `MembershipRepository.insert`, `MembershipRepository.setEnd` | inserts an overlapping membership: refused |
| NO2 | A membership's start is not after its end; the ordinals follow the term. | store-enforced | yes | `MembershipRepository.insert`, `MembershipRepository.setEnd` | inserts a membership that ends before it starts: refused |
| NO3 | Of two concurrent writes that overlap, exactly one commits and the other fails with `AlreadyExists`, never with a deadlock. | port-enforced | no | `MembershipRepository.insert`, `MembershipRepository.setEnd` | writes an overlapping term without the person's lock: it can meet the other write in a deadlock |

### ConditionalWrites

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| CW1 | A write that depends on a record's state is judged against its newest committed state when it takes effect: if the expected state no longer holds, nothing is written and the caller gets `Conflict`. Of two concurrent transitions from one state, exactly one wins. | port-enforced | no | `AccountRepository.transition`, `MembershipRepository.setEnd`, `MembershipRepository.remove` | writes the state unconditionally: both transitions win, in every round |
| CW2 | A replace never rewrites another owner's record, and replaces the owner's own. | port-enforced | no | `CodeRepository.replace`, `ConsentRepository.record` | replaces by a key that leaves the owner out: it rewrites another owner's record |
| RT1 | A retention run at one instant is idempotent: a second run at the same instant changes nothing. A record expires when its period, counted in Oslo calendar time from its trigger, has passed `now`. The mode (`Apply` or `ReportOnly`) is fixed by the layer: a program cannot choose it. | port-enforced | no | `RetentionRun.run` | edits a record that a run keeps, between two runs: the second run applies the same rule to it |
| ER1 | An erasure of one person applies each table's declared expiry and keeps the rows of a table that is `Kept`; a second call changes nothing. A merge moves every row of one person to another by the catalog's rules and makes the first a tombstone, or fails with `Conflict` and changes nothing. | port-enforced | no | `PersonalDataStore.erase`, `PersonalDataStore.merge`, `LegalHolds.of` | writes a row about the erased person after the erasure: the row stays, nothing erases it again until a rule says so |

### Claims

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| CL1 | At most one claim per key: the first-membership welcome per person; the ending-soon digest per person and semester; the alumni request per person and engagement end; a job's run per job and period; a company address; a captured message per delivery key. | store-enforced | yes | `WelcomeLedger.claim`, `DigestLedger.claim`, `AlumniRequests.claim`, `JobRuns.claim`, `WorkspaceAssignments.assign`, `CapturedMessageStore.record` | inserts a second claim with the same key: refused |
| CL2 | Of concurrent callers of one key, exactly one is told it made the claim; the others are told it was taken. | port-enforced | no | `WelcomeLedger.claim`, `DigestLedger.claim`, `AlumniRequests.claim`, `JobRuns.claim` | inserts the claim first: every port caller is told it was taken |
| CL3 | A claim commits with the writes it guards: the claim, the message queued for it and its audit row become visible together or not at all. A claim that commits alone is a message never sent. | port-enforced | no | `WelcomeLedger.claim` (in a transaction), `DigestLedger.claim` (in a transaction), `AlumniRequests.claim` (in a transaction), `Outbox.enqueue` (in a transaction), `AuditLog.record` (in a transaction) | commits a claim without its message: the key is taken and the message is never sent, so the port methods require the transaction |

### WorkQueue

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| LS1 | A pending outbox record has at most one live claim; of any number of claimers, exactly one holds it. A duplicate message finds it `Held` or `Settled` and never sends twice. | port-enforced | no | `OutboxDelivery.claim` | claims a record that another claim holds: it takes the record, and both senders send |
| LS2 | An acknowledgement or release that carries a claim token other than the record's current one changes nothing and reports `claimLost`. | port-enforced | no | `OutboxDelivery.markDelivered`, `OutboxDelivery.markFailed` | overwrites the claim token: a stale claimant's acknowledgement then succeeds |
| LS3 | Delivery is at least once, with no order across records; a provider can hear of a record twice when its send succeeded and the acknowledgement did not commit. | port-enforced | no | `OutboxDelivery` | no writer can make this false: it is a promise to callers |
| LS4 | `markDelivered` is one conditional write that joins the caller's transaction when there is one (the acknowledgement then commits or rolls back with the caller's writes) and commits alone otherwise. Which of the two holds is the caller's, and the port neither requires nor reports it. | port-enforced | no | `OutboxDelivery.markDelivered` | acknowledges outside the caller's transaction: the acknowledgement survives the caller's rollback |
| LS5 | The queue's receipt (`markQueued`) is recorded only for pending records; `stale` lists pending records with no live claim whose last receipt or next attempt is not after the cut-off; a dead ending is recorded only after a failure class was recorded. | port-enforced | no | `OutboxDelivery.markQueued`, `OutboxDelivery.stale`, `OutboxDelivery.markDead`, `OutboxDelivery.recordFailure` | ends a record that has no recorded failure: it ends, and the sweep no longer finds it |

### Leases

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| LS6 | A job's period has one runner: a claim never waits; a runner whose period was taken over writes nothing (`LeaseLost`); a chunk's rows and its cursor commit together. | port-enforced | no | `JobRuns.claim`, `JobRuns.advance` (in a transaction), `JobRuns.finish` (in a transaction), `JobRuns.release`, `JobRuns.fail` | writes a period's cursor without its attempt: a taken-over runner then adds to the run |

### Snapshots

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| SN1 | The export of one person reflects one committed state: no transaction's effects appear in part. It writes nothing and takes no lock. The method makes the snapshot itself, because its caller's transaction gives none (TX3). | store-enforced | no | `PersonalDataStore.exportOf` | commits a multi-table change while an export runs: the export shows all of it or none |
| SN2 | A person's principal (account state, memberships active in a given semester, the end of every admin place) is as of one committed state at the instant of the read, and is not refreshed during the request. A decision that must hold against later change does not rest on it: it is decided again under a lock (LK1, CW1, LK7). | store-enforced | no | `PrincipalDirectory.activeById`, `PrincipalDirectory.byName` | deactivates the account and ends a place in one commit while the read runs: the principal shows both or neither |

### ReadOnlyReads

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| RR1 | A read (every method of mode `Read`) writes nothing and takes no lock. | port-enforced | no | `AuditLog.latest`, `OutboxReports.overview`, `PrincipalDirectory.names`, `WorkspaceReports.latest` | no writer can make this false; a role that holds read access only shows that the port never writes |

### ObjectStore

| Id | Property | Strength | Invariant | Carriers | A raw writer |
| --- | --- | --- | --- | --- | --- |
| OS1 | `put` of one content-addressed key is idempotent: a repeat leaves the same object. | port-enforced | no | `FileStore.put` | puts different bytes under the same key: the object store keeps them, and only the key's derivation prevents it |

<!-- docgen:end guarantees -->

## What is not promised

<!-- docgen:begin non-guarantees -->

| Id | Not promised | Where |
| --- | --- | --- |
| SN3 | No snapshot is promised across separate reads: `OutboxReports.overview`, `WorkspaceFacts` and `WorkspaceReports.read`/`.latest` may each show a state that no single instant held. | `OutboxReports.overview`, `WorkspaceFacts.people`, `WorkspaceFacts.storedAddresses`, `WorkspaceReports.read`, `WorkspaceReports.latest` |

<!-- docgen:end non-guarantees -->

## Transaction mode of every port method

<!-- docgen:begin modes -->

| Port | Requires | Standalone | Joins | Read | Outside | Opens |
| --- | --- | --- | --- | --- | --- | --- |
| `AccountRepository` | `findLocked`, `invite`, `isLastActiveAdmin`, `transition`, `updateProfile`, `verifyEmail` |  |  | `find`, `findActiveByPrivateEmail`, `list` |  |  |
| `AdminGrantRepository` | `create`, `revoke` |  |  | `findById`, `list` |  |  |
| `AdmissionPeriodRepository` |  |  |  | `list` |  |  |
| `AggregateLocks` | `lock`, `lockAll` |  |  |  |  |  |
| `AlumniRequests` | `claim` |  |  | `candidates` |  |  |
| `AuditLog` | `record` |  |  | `latest` |  |  |
| `CapturedMessageStore` |  | `record` |  |  |  |  |
| `CodeRepository` | `consume`, `replace` |  |  | `findUsable` |  |  |
| `ConsentRepository` | `ofLocked`, `record` |  |  | `of` |  |  |
| `DepartmentRepository` |  | `create`, `update` |  | `findById`, `list` |  |  |
| `DigestLedger` | `claim` |  |  |  |  |  |
| `FieldOfStudyRepository` |  | `create`, `rename` |  | `findById`, `listByDepartment` |  |  |
| `FileStore` |  |  |  |  | `get`, `put` |  |
| `ImportTarget` |  |  |  |  |  | `replaceAll` |
| `IsolationProbe` |  |  |  |  |  | `report` |
| `JobRuns` | `advance`, `finish`, `request` | `claim`, `fail`, `release` |  | `resumable` |  |  |
| `LegalHolds` | `of` |  |  |  |  |  |
| `MembershipRepository` | `findLocked`, `insert`, `listLocked`, `remove`, `setEnd` |  |  | `activeIn`, `findById`, `listByPerson`, `listByTeam` |  |  |
| `Outbox` | `enqueue` |  |  |  |  |  |
| `OutboxDelivery` |  | `claim`, `markDead`, `markFailed`, `markQueued`, `recordFailure` | `markDelivered` | `stale` |  |  |
| `OutboxReports` |  |  |  | `overview` |  |  |
| `PersonRepository` | `create`, `findLocked` |  |  | `findById`, `list` |  |  |
| `PersonalDataStore` | `erase`, `merge`, `setPhoto` |  |  | `exportOf` |  |  |
| `PositionRepository` |  |  |  | `findById`, `list` |  |  |
| `PrincipalDirectory` |  |  |  | `activeById`, `byName`, `names` |  |  |
| `PublicFileRepository` |  | `register` |  | `findByKey`, `findByLegacyPath` |  |  |
| `RetentionRun` | `run` |  |  |  |  |  |
| `SemesterRepository` |  | `ensure` |  | `find`, `list` |  |  |
| `SessionDirectory` |  |  |  | `byPerson` |  |  |
| `SignInDirectory` |  |  |  | `match`, `personOfUser`, `profileOf`, `signInEmailOf` |  |  |
| `SocialEventRepository` |  | `create` |  | `list` |  |  |
| `TeamRepository` | `create`, `update` | `deactivate` |  | `findById`, `list` |  |  |
| `Transactor` |  |  |  |  |  | `run` |
| `WelcomeLedger` | `claim` |  |  |  |  |  |
| `WorkspaceAssignments` | `assign` |  |  |  |  |  |
| `WorkspaceDirectory` |  |  |  |  | `accounts`, `groups`, `members` |  |
| `WorkspaceFacts` |  |  |  | `configuredGroupAddresses`, `departmentEngagements`, `departments`, `people`, `storedAddresses`, `teamsAfter` |  |  |
| `WorkspaceReports` | `append`, `complete`, `open` |  |  | `latest`, `read` |  |  |
| `WorkspaceWriter` |  |  |  |  | `apply` |  |

<!-- docgen:end modes -->
