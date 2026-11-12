# App-shared core

Feature-specific domain code lives in `../features/<feature>/domain`. Core is the app-shared foundation, not a reusable package. The portable kernel and assembly registries live here, not in server. Transaction, aggregate and integration-guard contracts live in `transactions/`; store guarantees, modes and platform contracts live in `store/`; shared outbox contracts live in `outbox/outbox.ts`. IDs, errors, validation, clock and site origin live at the core root. There is no shared catchall. Use direct concrete-module imports.

Domain tests are in `apps/web/test/domain`; conformance artefacts are in `apps/web/conformance`. See [spec 0030](../../../../docs/specs/0030-app-local-feature-organisation.md) for boundary history and [the web guide](../../README.md) for current commands. Transaction proofs, ordered aggregate locks and service identities retain their existing semantics.

Spec [0032](../../../../docs/specs/0032-declared-lifecycles.md) adds `Machine.contribute`: a causing domain references another domain's actual machine and supplies its own typed command group and guard context. `Domain.incoming` and `resolvedMachines` derive the cross-domain reference view; `allProblems` checks ownership, target identity, state references, terminal exits and overlapping contributions. Contributions grant no authority. Account transfer is distinguished from deletion. Person and Team states project existing columns rather than introducing stored copies. Inactive teams refuse new/prolonged presence, not exits; `holdPresence` serializes membership admission with deactivation after the Person lock. effx receives explicit cross-domain/identity-transfer gaps and whole-machine omission rather than incomplete machines.

## Historical package references

The following two former package references are preserved for their detailed contracts and evidence. Their old paths, exports, commands, provider names and present-tense implementation claims refer to the earlier package layout and may not describe the current prototype. Use current source and the guides above instead of their instructions.

# @vektorprogrammet/domain

Effect v4 domain core: pure rule functions, branded types, typed errors, the declaration kernel (grants, subject sets, state machines, commands declared with `effect/rpc`), service interfaces, and command handlers over those services. It depends only on `effect` and `sanitize-html`; it never imports `packages/db`, `apps/*`, Drizzle or SQL drivers.

## The kernel (`src/kernel/`, spec 0006)

Domains are declared as data; the runtime, the control panel, the tests and `docs/system/` read the declarations.

| Module | What it is |
| --- | --- |
| `principal.ts` | `CurrentPrincipal`: `Anonymous`, `Person { personId, memberships (active this semester), adminUntil? }` or `System { job }` (a scheduled job). `TeamFunction`, `SystemJob`. |
| `subject.ts` | Subject sets include `Anyone`, `Admin`, `Leader`, `Self`, `Holder(purpose)` and `System(job)`. They read principal facts. |
| `grant.ts` | `Grant.make(subjects, commands, scope)`: a row; scope `own`, `department` or `all`. Only additive: no deny, no precedence. |
| `authorize.ts` | `authorize(principal, command, resource)` reads the grant table and every principal narrowing. `canAnywhere` drives the sidebar. |
| `guard.ts` | Native `Schema.makeFilter` checks over any ordered value (`ordered({ schema, order })`: typed paths, after/same/not/or, and `field`, the one constructor of a machine's fields), `describe` (a check in words, down to the operands of a `not` or an `or`), and `SchemaRepresentation` revivers. The semester's instance is `organisation/semesterGuard.ts` (spec 0022). Their JSON representations are available to compilers as well as the runtime. |
| `machine.ts` | `Machine.make` (transition tables over a `Schema.TaggedUnion` of states and a context schema, typed by the domain's `RpcGroup`), `can`, `startsFrom`, `available`, `next`. Guard checks are compiled once; their JSON is exposed in machine descriptions. Calculated transitions are declared, not stored, and each has a typed `guard` over the context (the first semester whose clock satisfies it: a start that has arrived, an end that has passed); its label in the diagram is the guard in words (`Guard.describe`), so there is no label to write beside it or to leave behind. A machine also says which states are `terminal` (required: `[]` is a statement) and which semesters its guards read as `fields`, each `stored` in the row, a `parameter` of the command or the `clock` (spec 0007d). |
| `commands.ts` | `Info` (the annotation each `Rpc` carries: summary, the `resource` it acts on and the `method` it uses, the legacy rules it replaces, the job that alone runs it, its machine), `Resource` and `Method` (closed sets), `inProcess` (the group's handlers behind a client in this process) and `endpoint` (untrusted input in, the command's own result out). |
| `domain.ts` | `Domain.make({ commands, reads, grants, machines, memberships? })`, `handle`, `problems` (what makes one declaration incomplete) and `allProblems` (those of every domain, and a tag or a resource and method that two commands share), `namesOf` (the names that a declaration's grant rows may carry). It also exposes the existing command metadata, grant constructor and subject sets for declarations. `departmentResource` selects the department from a command payload. `memberships` binds a domain to the machine whose states say that a membership grants (`teams`: `Active`). |
| `effx.ts` | `Effx.describe(declaration)`: the declaration as effx's `DomainDescription` (effx spec 0032) and the typed `Effx.Gap`s of what effx cannot state; `Effx.closures`: what closes each kind of gap; `Effx.committedJson`. Pure, and no dependency on effx (spec 0007d). |

`declarations.ts` lists every domain and builds `GrantTable` (the rows of all domains, and the one `Admin` row that names everything a person may run) and the root `authorize` and `canAnywhere`. A domain that is not in that list has no permissions and no page.

A principal is a person with facts, never a role (ADR 0001). Every scheduled job runs as its own `System` principal through the same `authorize`; the job registry and its grant checks are in `src/jobs`. No person holds a job's command, an admin included.

**A command names its resource and method** (ADR 0010, spec 0007c): `info({ summary, resource: "Membership", method: ":extend" })`. `resource` is `EntityName` or one of the nouns in `NonEntityResources` (`kernel/commands.ts`); `method` is `get`, `list`, `create`, `update`, `delete`, or a custom verb with a colon. Both are required, so a command without them does not type-check. `Domain.problems` then checks what the types cannot: a standard method's name is its verb and resource (`createTeam`, `updatePerson`), a `list` and a custom method start with their verb (`listAuditEntries`, `extendMembership`), a `get` or `list` changes nothing (no machine, job or credential), a `create` starts every transition from `[*]`, a `delete` ends every transition in `[*]`, an `update` changes no state, and no two commands share a resource and method. There is no way to promise a `412`: no row version exists. `docs/system/commands.md` lists every command by resource.

**The declarations are exported to effx** (ADR 0009, spec 0007d). `Effx.describe` turns a domain into a `DomainDescription`, and `tools/effx-conformance` hands each description to effx, which writes conformance vectors: for every small world, who may run which command about which target, and which transition of each machine, a command's or one that time makes, is enabled. The kernel's own `authorize` and machine tables are asked every row of those vectors in `vp run -r test`. The descriptions, the vectors (effx's packages are not published, so they are committed with their provenance, which records how effx was asked) and the register of gaps are in `conformance/` and are generated: `bun run description` after a change to a grant, a subject set or a machine, then `bun run description:regenerate` (it needs a checkout of effx at the pinned commit and Nix; `tools/effx-conformance/README.md`). A construct that effx cannot state (`Anyone` and `Holder(purpose)` subjects, a guard over ids or flags, the aggregate roots) is a typed `Effx.Gap` in `conformance/gaps.json`, never a silent drop, and the command that an `UnexpressibleSubject` gap names stays out of its description. `Effx.closures` says, for every kind of gap, whether the kernel or effx closes it and what changes. A weekly job (`.github/workflows/effx-drift.yml`) checks that effx's `main` still makes the committed vectors.

## Bounded contexts (`src/`)

| Context | Capabilities | Contents |
| --- | --- | --- |
| `kernel`, `shared` | all | the kernel above; ids, errors (`NotFound`, `Forbidden`, `AlreadyExists`, `Conflict`, `ValidationFailed`), Oslo clock helpers, `Outbox`, `InTransaction`, `AggregateLocks` and `Locked` (the lock token), `SiteOrigin`, input decoding |
| `organisation` | C1, C2 | departments, fields of study, semesters (RULE-022/033/050/051/084/237), admission decisions (RULE-015/119), the `OrganisationRpc` commands, the semester job (`semesterJob`) and the pure semester reads (`currentSemester`, `findCurrentSemester`) |
| `teams` | spec 0006 | `Person`, `Team`, `Position`, `Membership` (a term of two semesters, its state calculated in `term.ts`), `AdminGrant`; the `TeamsRpc` commands and the Membership machine; the ending-soon digest (`endingSoon.ts`) |
| `accounts` | spec 0007 | The Account machine, `AccountRpc`, password policy, single-use Code and request-scoped code principals. [Account reference](../../docs/system/accounts.md). |
| `cms` | C3, C5, C8 | Shared collection schemas, Portable Text and content service contracts, exported only through `@vektorprogrammet/domain/cms`. Persistence is implemented by `packages/db`; published and draft snapshots remain separate. |
| `content` | C3, C5, C8 | the pure rules the public pages use (page size and order of news RULE-326/331, the sponsors' footer order), the rich-text sanitizer (RULE-133, run by the CMS importer), slugs, social events (RULE-085/188). Articles, static texts and sponsors live in the CMS since spec 0005 |
| `contact` | C10 | support ticket (RULE-156/327) and its notifications (RULE-249) |
| `files` | C11 | magic-byte typing (RULE-130), serving policy and registered-only access (RULE-290) |
| `audit` | C12 | `AuditEntry` (it records the principal: a person id or a job name), `AuditLog`, `recordAudit`, the `listAuditEntries` query |
| `outbox` | C12 | Scheduled and post-commit delivery commands, retry policy, and the administrator status view; handlers live in `apps/web`. |
| `jobs`, `workspace` | spec 0008 | The closed registry and due rules; Workspace projection, report, read/write ports and commands. |
| `personalData` | spec 0007b | The declarations (`declaration.ts`: columns, retention, expiry, person relations, merge rules), `catalog.ts` (every domain's `personalData.ts` gathered), `periods.ts` and `texts.ts` (the periods and the privacy and consent texts, each with an `approval`, and `basesApproval`, the one approval of the legal bases), `duration.ts` (the words of a period: every text that states one builds it there), the readings (`derive.ts`: retention rules and whether a retention rests on a proposal, the checks of the catalog; `notice.ts`: the privacy notice of a form, which carries the decisions that are open and `draftNote`, the one sentence that names them, and the record of processing, whose rows carry the approval of the period and of the basis), the consent records, the alumni rules, and the `PersonalDataRpc` commands with the retention and alumni jobs. [Reference](../../docs/system/administration.md). |

## Services

| Service | One line |
| --- | --- |
| `CurrentPrincipal` | the acting party; provided per request (a person) or per job (`System`) by `apps/web` |
| `InTransaction` | proof that the program runs in a DB transaction; provided only by `packages/db`'s runner |
| `AggregateLocks` | `lock(root, id)` and `lockAll(root, ids)`: the row lock of an aggregate root (the admin list, then a person), as the token `Locked<Root>` that every decision read and write of the root's own rows takes (spec 0006b); implemented by `packages/db`, provided in memory by the test layer |
| `DepartmentRepository` | `list`, `findById`, `create`/`update` (`AlreadyExists` on unique city) |
| `SemesterRepository` | `list`, `find`, atomic `ensure` (RULE-237; only the scheduled job calls it, spec 0003) |
| `FieldOfStudyRepository` | `listByDepartment`, `findById`, `create`, `rename` |
| `AdmissionPeriodRepository` | `list` (read-only; the public pages ask which admission is open) |
| `PersonRepository`, `TeamRepository`, `PositionRepository` | people, teams (unique name per department, deactivated and never deleted), the position value list |
| `MembershipRepository` | reads, `findLocked` and `listLocked` for a decision, and `insert` (no overlap: `AlreadyExists`), the conditional `setEnd` and `remove` (a lost race is a `Conflict`); a write takes the person's `Locked` token |
| `AdminGrantRepository` | the admin list; `create` takes the admin list's and the person's `Locked` tokens; `revoke` refuses the last place that ends after the current semester and that an Active account holds, atomically, under the admin list's lock (spec 0006b R2) |
| `AccountRepository`, `CodeRepository`, `PasswordHasher` | Account state (a transition is applied under the person's lock; `isLastActiveAdmin` reads through the admin list's lock), conditional code use and the bcrypt boundary. |
| `DigestLedger` | one row per leader and semester: the digest goes out once |
| `PrincipalDirectory` | loads a person's facts in one read (`apps/web` uses it to build the principal) |
| `SocialEventRepository` | `list({ departmentId, semesterId })`, `create` |
| `PublicFileRepository` | `findByKey`, `findByLegacyPath`, idempotent `register` |
| `ConsentRepository`, `AlumniRequests`, `LegalHolds`, `PersonalDataStore` | A person's consent records (read for display, written through their `Locked` token); the people to ask and the one request for each end of an engagement; the legal holds on a person (no source yet); and the operations that the catalog compiles in `packages/db`: the export, the early expiry of an erasure, the photo (spec 0007b) |
| `RetentionRun` | the nightly retention run (spec 0007b R4): `run(now)` gives the counts and the mode, `Apply` (rows changed) or `ReportOnly` (rows that would be, and nothing changed). The layer fixes the mode, so no program chooses it: `DatabaseLive` provides the report, and only `packages/db`'s `JobDatabaseLive` can provide the run that changes rows |
| `FileStore` | R2 `put` and `get` by content-addressed key |
| `Outbox` | Enqueues e-mail, Slack, account-delivery and Workspace intents in the current transaction. |
| `AuditLog` | `record` one `AuditEntry` per write in the current transaction, `latest` |
| `JobRuns`, `WorkspaceFacts`, `WorkspaceReports` | Claim and fence job periods, read projection inputs, and persist report chunks. |
| `WelcomeLedger` | Claims one first-membership notification under a Person token in the same transaction as membership and outbox. |
| `WorkspaceDirectory`, `WorkspaceWriter` | Separate provider read and mutation capabilities. The production Google adapter is not configured. |
| `SiteOrigin` | the origin that the links in messages carry |

`storeUpload` also needs Effect's `Crypto.Crypto` (SHA-256); `apps/web` provides a Web Crypto implementation.

`authorize` is the one answer to "may this principal do this?". Every command handler is built with its domain's `handle`, which asks the table before the command runs (and refuses with `Forbidden`); `apps/web` asks the same function for the control panel's sidebar and for every control a page offers (spec 0004), so a control the principal may not use is not rendered. A role check in `apps/web` is a second list, and `apps/web/test/shell.test.ts` fails when a control and its command disagree.

## Errors

A closed set: `NotFound`, `Forbidden`, `AlreadyExists`, `Conflict`, `ValidationFailed` (`DomainError`). A `Conflict` is a transition that could not be applied: the resource is not in a state that the command starts from, or it changed between the read and the conditional update. Infrastructure failures are defects.

`Forbidden.command` is a string, as it is on the wire: the error sits below the declarations that give the names. A command that refuses on its own, for a rule that no grant row can state (never for oneself), builds the refusal with its domain's `forbidden` (`TeamsDomain.forbidden("createAdminGrant")`), whose parameter is the names of that domain's group and reads, so a renamed or misspelled command does not compile (spec 0007c R2). The code endpoints refuse with the command of the code's purpose, `codePolicy[purpose].command`: `runWithCode` takes the domain that runs the endpoint (`AccountDomain` or `PersonalDataDomain`), so the same parameter checks the command against that domain. `setAlumniConsent` and `exportMyData` are granted to `Self`, but the kernel's `Admin` row would admit an administrator for any person, so their handlers refuse every principal that is not the person with the same `forbidden` (spec 0007b R3 item 27).

## Transaction convention

Commands do not open transactions; atomic commands **require `InTransaction`**, and `packages/db` provides it by wrapping the program in `SqlClient.withTransaction`. `storeUpload` and all queries run outside a transaction. A command that writes a person's own rows takes the person's lock first (`AggregateLocks`, spec 0006b). Details and the full command table: [`src/README.md`](src/README.md).

## Tests

`@vektorprogrammet/domain/testing` exports the in-memory teams repositories (`TeamsInMemory`, `TeamTables`) for the tests of `apps/web`.

```
bunx vp test    # acceptance tests, named by rule id
bunx vp check   # format, lint, type check
```

---

# Implementing `@vektorprogrammet/domain` (for `packages/db` and `apps/web`)

## Transaction convention

Commands never open a transaction. A command that must be atomic **requires the `InTransaction` service** (`shared/transaction.ts`), so running it unwrapped does not type-check.

A store adapter owns the one production provider (`packages/db`'s `transactional`, behind `Transactor`). Its runner wraps the program in one transaction of the store and provides `InTransaction` inside it: a fresh proof for each level (spec 0019). Every adapter method that `TransactionModes` marks `Requires` checks, before its first statement, that the proof the program holds is the innermost level's of its connection, and dies as `TransactionNotLive` otherwise; it counts as running until it ends, and a nested level is refused while a method of the level around it runs and when it is asked for from a level that is not the innermost live one; the adapter's stack of levels is PostgreSQL's stack of savepoints (spec 0019 R18, R21). TX5 (`shared/guarantees.ts`) says what that refuses and what it does not, and spec 0019 R14 and R18 why the check does not look at the fiber: the in-process RPC server runs command handlers on fibers of its own. A source test is a lint against accidental provision: it fails at review time if another file holds the service as a value or writes its key as a string. What the proof promises is declared in `shared/guarantees.ts` (spec 0018): atomic visibility and rollback (TX1), nested scopes (TX2), the isolation floor ReadCommittedWithLocks (TX3), no retry of a deadlock (TX4) and its provision (TX5).

- Repository Layers run in the transaction that is open, so their writes join it. A typed failure, a defect or an interruption rolls everything back, including the audit row and the outbox rows.
- Authorization (`Domain.handle`) runs inside the transaction.
- No provider I/O inside a transaction. For another system (mail, Slack, Turnstile, Better Auth, the Workspace directory) it is a type: the port is an `IntegrationPort` (`shared/transaction.ts`), and `Transactor.run` does not accept a program that requires one (ADR 0015 rule 1, spec 0020). R2 (`FileStore`) is the platform, not an integration, and stays a convention.

## Store ports (spec 0017, ADR 0014 stage 1)

A port is a service the domain declares and a store implements; `packages/db` holds the PostgreSQL adapters, and no module outside a composition root imports them (`bun run check:store-boundary`). Each port's file states the guarantee that its adapter must keep.

| Port | File | What it lets the caller do |
| --- | --- | --- |
| `Transactor` | `shared/transactor.ts` | `run(program)`: the program is one transaction and gets `InTransaction`; a typed failure, a defect or an interruption rolls it back. |
| `OutboxDelivery` | `outbox/delivery.ts` | Find due rows, claim by id, and record outcomes with the claim token. |
| `CapturedMessageStore` | `outbox/captured.ts` | Keep a non-production message once per delivery key. |
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
- `Crypto.Crypto` (effect): a Web Crypto implementation (`Crypto.make`), used by `storeUpload` for SHA-256.
- `FileStore`: the R2 binding.
- `Clock`: Effect's default clock; tests use `TestClock`.
