# Implementing `@vektorprogrammet/domain` (for `packages/db` and `apps/web`)

## Transaction convention

Commands never open a transaction. A command that must be atomic **requires the `InTransaction` service** (`shared/transaction.ts`), so running it unwrapped does not type-check.

`packages/db` owns the only production provider. Its runner wraps the program in the SQL client's transaction and provides `InTransaction` inside it:

```ts
// packages/db (sketch)
export const runInTransaction = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.provideService(program, InTransaction, {
        kind: "database-transaction",
      })
    );
  });
```

- Repository Layers use the ambient `SqlClient`, so their queries join the transaction. A typed failure, a defect or an interruption rolls everything back, including the audit row and the outbox rows.
- Authorization (`Domain.handle`) runs inside the transaction.
- No provider I/O (R2, mail, Slack, Turnstile) inside a transaction.

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

- Methods fail only with the listed domain errors. Everything else (lost connection, unexpected SQL state) is a defect. Existing-Person decision reads and writes take the Person token; Person and Team creation or update that claims an address also requires `InTransaction`.
- Unique constraints map to `AlreadyExists` (entity, key, Norwegian message): department `city`, team name per department, person e-mail, and the exclusion constraint that keeps one person's memberships in one team from overlapping. Commands may replace the message.
- A transition is a conditional update: `MembershipRepository.setEnd` is `UPDATE … SET end = $new WHERE id = $1 AND end = $observed AND <active>`, and `remove` is `DELETE … WHERE id = $1 AND term = $observed AND <planned>`. Zero rows is a `Conflict`, never a silent overwrite. The state is calculated from the term and the current semester (`teams/term.ts`) and stored nowhere. A stored machine's state (the account's) is written only by `AccountRepository.transition`, which applies one transition of the machine: `UPDATE … SET state = to WHERE owner = $1 AND state = ANY(from)`.
- `AdminGrantRepository.revoke(adminList, holder, id, validAfter)` is atomic (it requires `InTransaction`): it reads the places that end after `validAfter` and that an Active account holds through the admin list's token, then deletes the place through the holder's token unless it is the last of them (`"last"`). Two revocations at once cannot both succeed, and a place that a deactivated account holds does not count.
- `SemesterRepository.ensure` is `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING *`, one statement that returns the existing row too, so concurrent callers all get the one row (RULE-237, spec 0001 R1). Only the semester job, run by the Worker's `scheduled` handler, calls it (spec 0003): the current semester and its successor `nextSemester` (RULE-050). A read asks `currentSemester` (pure: calendar and `Clock`) or `findCurrentSemester` (the row, `None` until the job has written it); it never inserts.
- `DigestLedger.claim` is `INSERT … ON CONFLICT DO NOTHING RETURNING`: true for the first caller, false after. The ledger row and the outbox row commit together.
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
