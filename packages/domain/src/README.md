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
- Authorization (`requireCapability`) runs inside the transaction.
- No provider I/O (R2, mail, Slack, Turnstile) inside a transaction.

| Needs `InTransaction` (wrap with the runner) | Runs outside a transaction |
| --- | --- |
| `createSemester`, `createDepartment`, `updateDepartment`, `createFieldOfStudy`, `renameFieldOfStudy` | `ensureCurrentSemester` (one atomic upsert; no audit) |
| `updateStaticContent`, `createArticle`, `setArticlePublished`, `createSponsor`, `createSocialEvent` | `storeUpload` (R2 put; **must not** be in a transaction) |
| `registerPublicFile`, `submitContact` | queries: `listSemestersNewestFirst`, `listFieldsOfStudy`, `getStaticContent`, `getPublicArticle`, `loadFrontPageNews`, `loadNewsPage`, `listSponsorsForFooter`, `servePublicFile`, `resolveLegacyFilePath` |

Uploads are two steps: `storeUpload` (no transaction) returns a `StoredUpload`; pass it to `registerPublicFile` inside the runner. Keys are content hashes, so an orphaned or repeated put is harmless.

## Repository contract

- Methods require nothing and fail only with the listed domain errors. Everything else (lost connection, unexpected SQL state) is a defect (`Effect.orDie` after `classifySqlFailure`).
- Unique constraints map to `AlreadyExists` (entity, key, Norwegian message): department `city`, article `slug`, semester `(term, year)`. Commands may replace the message (e.g. RULE-144's "Semesteret Høst 2026 finnes allerede").
- `SemesterRepository.create` is `INSERT … ON CONFLICT (term, year) DO NOTHING RETURNING`; no row → `AlreadyExists`. `ensure` is `INSERT … ON CONFLICT (term, year) DO UPDATE SET term = EXCLUDED.term RETURNING *`, one statement that returns the existing row too, so concurrent callers all get the one row (RULE-237, spec 0001 R1).
- `PublicFileRepository.register` is idempotent on `key`.
- Repositories do not order rows; rule functions do (`sortNewestFirst`, `selectFrontPageNews`, `sortSponsorsForFooter`).
- Decode rows with the domain schemas (`Department`, `StoredSemester`, `Article`, `StaticContent`, `Sponsor`, `SocialEvent`, `PublicFile`, `OutboxMessage`, `AuditEntry`). `Article.body` and `StaticContent.html` use `SanitizedHtmlFromString`, which re-sanitizes stored HTML on every read (RULE-133 replacement: sanitize on save and on render).
- `timestamptz` ↔ `DateTime.Utc`. The calendar zone (Europe/Oslo) is applied by the rule functions, never by the database.

## Per-request services `apps/web` provides

- `CurrentActor`: `Anonymous`, or `Staff` from the session (Phase 1: test session only).
- `Crypto.Crypto` (effect): a Web Crypto implementation (`Crypto.make`), used by `storeUpload` for SHA-256.
- `FileStore`: the R2 binding.
- `Clock`: Effect's default clock; tests use `TestClock`.
