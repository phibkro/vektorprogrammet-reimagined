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

## Commands

Each domain declares its commands as `Rpc.make` in one `RpcGroup` (`declaration.ts`), and its handlers in `commands.ts` with `Domain.handle(rpc, { resource, run })`. A server function does not call a handler directly: it calls an **endpoint** (`XEndpoints.command(input)`), which decodes the untrusted input with the command's payload schema (a `ValidationFailed` on failure) and calls the handler through the in-process client (`withX`, from `Commands.inProcess`). The caller wraps the whole thing in `Transactor.run`, so the client, the handler, its audit row and its outbox rows share one transaction.

| Needs `InTransaction` (wrap with the runner) | Runs outside a transaction |
| --- | --- |
| `OrganisationEndpoints.*`, `ContentEndpoints.createSocialEvent`, `ContactEndpoints.submitContact`, `FilesEndpoints.registerPublicFile`, every `TeamsEndpoints.*` | `storeUpload` (R2 put; **must not** be in a transaction); `currentSemester` and `findCurrentSemester` (reads); queries: `listSemestersNewestFirst`, `listFieldsOfStudy`, `servePublicFile`, `resolveLegacyFilePath` |
| the jobs: `semesterJob` (`System("semesters")`), `endingSoonJob` (`System("endingSoon")`) | the outbox sweep (`sweepOutbox`, `System("outboxSweep")`): each claim and mark is its own statement |

A job is provided `CurrentPrincipal` = `System(job)` by its runner (`apps/web`), and then passes through `authorize` like any command.

The pure rules of the public pages (`selectFrontPageNews`, `paginate`, `sortSponsorsForFooter`, `slugify`) take already-read rows: the news, texts and sponsors come from the CMS (spec 0005), not from a repository.

Uploads are two steps: `storeUpload` (no transaction) returns a `StoredUpload`; pass it to `FilesEndpoints.registerPublicFile` inside the runner. Keys are content hashes, so an orphaned or repeated put is harmless.

## Repository contract

- Methods require nothing and fail only with the listed domain errors. Everything else (lost connection, unexpected SQL state) is a defect (`Effect.orDie` after `classifySqlFailure`).
- Unique constraints map to `AlreadyExists` (entity, key, Norwegian message): department `city`, team name per department, person e-mail, and the exclusion constraint that keeps one person's memberships in one team from overlapping. Commands may replace the message.
- A transition is a conditional update: `MembershipRepository.setEnd` is `UPDATE … SET end = $new WHERE id = $1 AND end = $observed AND <active>`, and `remove` is `DELETE … WHERE id = $1 AND term = $observed AND <planned>`. Zero rows is a `Conflict`, never a silent overwrite. The state is calculated from the term and the current semester (`teams/term.ts`) and stored nowhere.
- `AdminGrantRepository.revoke` locks the places that end after `validAfter`, then deletes unless the place is the last of them (`"last"`): two revocations at once cannot both succeed.
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
