# Implementing `@vektorprogrammet/domain` (for `packages/db` and `apps/web`)

## Transaction convention

Commands never open a transaction. A command that must be atomic **requires the `InTransaction` service** (`shared/transaction.ts`), so running it unwrapped does not type-check.

A store adapter owns the one production provider (`packages/db`'s `transactional`, behind `Transactor`). Its runner wraps the program in one transaction of the store and provides `InTransaction` inside it. A source test fails if another file holds the service as a value or writes its key as a string; that is a guard against accidental provision and not a proof (Effect keys a service by a string, so a deliberate forgery needs no reference to it: spec 0018 R20, and the unforgeable construction is a later spec). What the proof promises is declared in `shared/guarantees.ts` (spec 0018): atomic visibility and rollback (TX1), nested scopes (TX2), the isolation floor ReadCommittedWithLocks (TX3), no retry of a deadlock (TX4) and its provision (TX5).

- Repository Layers run in the transaction that is open, so their writes join it. A typed failure, a defect or an interruption rolls everything back, including the audit row and the outbox rows.
- Authorization (`Domain.handle`) runs inside the transaction.
- No provider I/O inside a transaction. For another system (mail, Slack, Turnstile, Better Auth, the Workspace directory) it is a type: the port is an `IntegrationPort` (`shared/transaction.ts`), and `Transactor.run` does not accept a program that requires one (ADR 0015 rule 1, spec 0020). R2 (`FileStore`) is the platform, not an integration, and stays a convention.

## Store ports (spec 0017, ADR 0014 stage 1)

A port is a service the domain declares and a store implements; `packages/db` holds the PostgreSQL adapters, and no module outside a composition root imports them (`bun run check:store-boundary`). Each port's file states the guarantee that its adapter must keep.

| Port | File | What it lets the caller do |
| --- | --- | --- |
| `Transactor` | `shared/transactor.ts` | `run(program)`: the program is one transaction and gets `InTransaction`; a typed failure, a defect or an interruption rolls it back. |
| `OutboxDelivery` | `outbox/delivery.ts` | Claim one outbox row by id, record the outcome with the claim token, mark dead, record the queue's receipt, list stale rows. |
| `CapturedMessageStore` | `outbox/captured.ts` | Keep a non-production message once per delivery key. |
| `SessionDirectory` | `accounts/sessionDirectory.ts` | `byPerson`: a person's live sessions, each with its last seen (`SessionActivity`). |
| `SignInDirectory` | `accounts/signInDirectory.ts` | The four reads that Better Auth's callbacks need of a person: the person of a user, the identity behind an address, the sign-in address, the profile to create a user from. |
| `ImportTarget` | `organisation/legacyImport.ts` | The legacy import's one transaction over `TargetTable`s. |

## Store guarantees (spec 0018, ADR 0014 stage 2)

`shared/guarantees.ts` declares each guarantee a store keeps as a property of an abstract store (records, keys, transactions, committed state), with its capability, its strength (`store-enforced`: it holds against every writer, the importer and migrations included; `port-enforced`: only against writers that use the port), whether it is an invariant, the port methods that carry it, the ones that need a transaction (`transactional`, checked against the modes) and what a raw writer would try. It is the one place where a property is stated in full; this README and the port comments cite an id. An invariant is store-enforced, with one named exception, the last administrator (LK7). `shared/transactionModes.ts` declares what every port method asks of a transaction (`Requires`, `Standalone`, `Joins`, `Read`, `Outside`, `Opens`), and a type test checks each row against the method's type. `docs/system/store-guarantees.md` is both, rendered (`bun run docs`). `InTransaction` promises the isolation floor TX3 (ReadCommittedWithLocks); a program that needs one state across unlocked reads reads it in one call (`exportOf`, `PrincipalDirectory`) or locks (SN1, SN2). `IsolationProbe` is the port that reports the levels a deployed store gives (spec 0018 R10).

## Aggregate locks (spec 0006b)

A person's own rows (memberships, admin places, the account and its codes) are written only by a transaction that holds the person's row lock. `shared/aggregate.ts` declares the contract; `packages/db` makes the tokens and checks them.

- `AggregateRoots` lists the roots in the order that a transaction locks them (`["AdminList", "Person"]`: the admin list's one row, then people in ascending id). `AggregateLocks.lock(root, id)` and `lockAll(root, ids)` require `InTransaction` and return `Locked<Root>`, the token of a held lock (`NotFound` when the row is not there). `lockAll` locks the rows of one root in ascending id order, in one statement. A lock that would come before one the transaction holds is a defect, so a command locks everything it needs, once, before its first decision read. `lockAdminList` is `lock("AdminList", ADMIN_LIST_ID)`.
- Decision reads and writes of an existing Person take its token, including `PersonRepository.findLocked`, the membership and admin-place writes, account/profile changes, codes and `WorkspaceAssignments.assign`. Display reads take none. Person creation is the exception to handler-first locking: its repository inserts a new row with no company address, locks that new row, then claims and assigns an optional company address in the same transaction.
- A handler locks first, then reads through the token, decides, and writes through it:

```ts
const locked = yield * (yield * AggregateLocks).lock("Person", personId);
const terms = yield * memberships.listLocked(locked); // the facts the decision rests on
// … decide with the pure rule functions …
yield * memberships.insert(locked, draft);
```

- Whether an Active administrator is left spans every administrator, so it is decided under the admin list's lock (`lockAdminList`, spec 0006b R2), which comes before every person: `deactivateAccount`, `reactivateAccount`, `createAdminGrant` and `deleteAdminGrant` lock it first, and `AccountRepository.isLastActiveAdmin` and `AdminGrantRepository.revoke` read through its token. A place counts only while an Active account holds it. A decision about a few known people (a merge) locks all of them in one `lockAll` and reads through every token.
- `apps/web`'s in-memory test layer (`@vektorprogrammet/domain/testing`) provides the same service, so a handler's tests run the same protocol without a database.

## Commands

Each domain declares its commands as `Rpc.make` in one `RpcGroup` (`declaration.ts`), and its handlers in `commands.ts` with `Domain.handle(rpc, { resource, run })`. A server function does not call a handler directly: it calls an **endpoint** (`XEndpoints.command(input)`), which decodes the untrusted input with the command's payload schema (a `ValidationFailed` on failure) and calls the handler through the in-process client (`withX`, from `Commands.inProcess`). The caller wraps the whole thing in `Transactor.run`, so the client, the handler, its audit row and its outbox rows share one transaction.

| Needs `InTransaction` (wrap with the runner) | Runs outside a transaction |
| --- | --- |
| `OrganisationEndpoints.*`, `ContentEndpoints.createSocialEvent`, `ContactEndpoints.submitContact`, `FilesEndpoints.createPublicFile`, every `TeamsEndpoints.*` | `storeUpload` (R2 put; **must not** be in a transaction); `currentSemester` and `findCurrentSemester` (reads); queries: `listSemestersNewestFirst`, `listFieldsOfStudy`, `servePublicFile`, `resolveLegacyFilePath` |
| the jobs: `semesterJob` (`System("semesters")`), `endingSoonJob` (`System("endingSoon")`) | the outbox's commands (`sweepOutbox`, `deliverOutbox`, `failOutbox`, all `System("outboxSweep")`): each claim and mark is its own statement |

A job is provided `CurrentPrincipal` = `System(job)` by its runner (`apps/web`), and then passes through `authorize` like any command.

Spec 0008's `prepareSync` reads the provider before the transaction; `syncWorkspace` writes the report chunk and the scheduler advances its cursor in the same transaction. An explicit report request always uses dry-run mode. Scheduled writes require both the mode recorded at the beginning of the run and the current setting to be `write`. The report also contains department-scoped mailing lists from active engagement facts. Spec 0011 can add placement facts without changing their projection contract. `createMembership` takes the Person lock before checking history, claiming `WelcomeLedger` and enqueuing the welcome and setup messages; all three persist together.

The pure rules of the public pages (`selectFrontPageNews`, `paginate`, `sortSponsorsForFooter`, `slugify`) take already-read rows: the news, texts and sponsors come from the CMS (spec 0005), not from a repository.

Uploads are two steps: `storeUpload` (no transaction) returns a `StoredUpload`; pass it to `FilesEndpoints.createPublicFile` inside the runner. Keys are content hashes, so an orphaned or repeated put is harmless.

## Repository contract

- Methods fail only with the listed domain errors. Everything else (lost connection, an unexpected failure of the store) is a defect. Every method that takes a lock token requires `InTransaction` (a token is good only in the transaction that holds it, LK3): the decision reads and writes of an existing Person and of the admin list. So do Person and Team creation or update that claims an address. `TransactionModes` (`shared/transactionModes.ts`) declares the mode of every method of every port, and a type test checks each against its type.
- A duplicate key maps to `AlreadyExists` (entity, key, Norwegian message; UK2): department `city`, team name per department, person e-mail, and the rule that keeps one person's memberships in one team from overlapping (NO1). Commands may replace the message.
- A transition is a conditional write (CW1): `MembershipRepository.setEnd` and `remove` apply only while the membership is still in the state the caller read. Nothing written is a `Conflict`, never a silent overwrite. The state is calculated from the term and the current semester (`teams/term.ts`) and stored nowhere. A stored machine's state (the account's) is written only by `AccountRepository.transition`, which applies one transition of the machine, and only from a state that the transition starts from.
- `AdminGrantRepository.revoke(adminList, holder, id, validAfter)` is atomic (it requires `InTransaction`): it reads the places that end after `validAfter` and that an Active account holds through the admin list's token, then deletes the place through the holder's token unless it is the last of them (`"last"`). Two revocations at once cannot both succeed, and a place that a deactivated account holds does not count.
- `SemesterRepository.ensure` is one find-or-create step that returns the existing record too (UK3), so concurrent callers all get the one record (RULE-237, spec 0001 R1). Only the semester job, run by the Worker's `scheduled` handler, calls it (spec 0003): the current semester and its successor `nextSemester` (RULE-050). A read asks `currentSemester` (pure: calendar and `Clock`) or `findCurrentSemester` (the record, `None` until the job has written it); it never inserts.
- `DigestLedger.claim` records the digest for a leader and semester once (CL1, CL2): true for the first caller, false after. The ledger row and the outbox row commit together, so the claim, `Outbox.enqueue`, `AuditLog.record` and `AlumniRequests.claim` all require `InTransaction` (CL3): a program that calls one of them outside `Transactor.run` does not type-check.
- `PublicFileRepository.register` is idempotent on `key`.
- Repositories do not order rows beyond what their doc says; rule functions do (`sortNewestFirst`).
- Decode rows with the domain schemas (`Department`, `StoredSemester`, `SocialEvent`, `PublicFile`, `OutboxMessage`, `AuditEntry`, `Person`, `Team`, `Membership`, `AdminGrant`).
- `timestamptz` ↔ `DateTime.Utc`. The calendar zone (Europe/Oslo) is applied by the rule functions, never by the database.

## Per-request services `apps/web` provides

- `CurrentPrincipal`: `Anonymous`, or the person's facts (`PrincipalDirectory`; Phase 2: the local test person, spec 0007 adds sign-in); a job provides `System(job)`.
- `SiteOrigin`: the deployment's origin, for the links in messages.
- `Digest.Digest` and `SecureRandom.SecureRandom` (`effect/crypto`): the Web Crypto layers (`Digest.layerWebCrypto`, `SecureRandom.layerWebCrypto`), used by `storeUpload` and the codes for SHA-256 and random bytes.
- `FileStore`: the R2 binding.
- `Clock`: Effect's default clock; tests use `TestClock`.
