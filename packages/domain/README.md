# @vektorprogrammet/domain

Effect v4 domain core for Phase 1: pure rule functions, branded types, typed errors, capability-based authorization, service interfaces, and commands as Effect programs over those services. It depends only on `effect` and `sanitize-html`; it never imports `packages/db`, `apps/*`, Drizzle or SQL drivers.

## Bounded contexts (`src/`)

| Context | Capabilities | Contents |
| --- | --- | --- |
| `shared` | all | ids, `Actor`/`CurrentActor`, `Capability`/`authorize`, errors, Oslo clock helpers, `Outbox`, `InTransaction`, input decoding |
| `organisation` | C1, C2 | departments, fields of study, semesters (RULE-022/033/050/051/084/190), admission decisions (RULE-015/119), C1 commands |
| `content` | C3, C4, C5, C6, C8 | rich-text sanitizer (RULE-133), slugs (RULE-096), articles (RULE-182/266/267/326/331), static content (RULE-296), sponsors (RULE-189), social events (RULE-085/188), countdown (RULE-070) |
| `contact` | C10 | support ticket (RULE-156/327) and its notifications (RULE-249) |
| `files` | C11 | magic-byte typing (RULE-130), serving policy and registered-only access (RULE-290) |
| `audit` | C12 | `AuditEntry`, `AuditLog`, `recordAudit` |

## Services

| Service | One line |
| --- | --- |
| `CurrentActor` | the request's `Actor` (`Anonymous` or `Staff`); provided per request by `apps/web` |
| `InTransaction` | proof that the program runs in a DB transaction; provided only by `packages/db`'s runner |
| `DepartmentRepository` | `list`, `findById`, `create`/`update` (`AlreadyExists` on unique city) |
| `SemesterRepository` | `list`, `find`, `create` (`AlreadyExists`, RULE-144), atomic `ensure` (RULE-237) |
| `FieldOfStudyRepository` | `listByDepartment`, `findById`, `create`, `rename` |
| `ArticleRepository` | `create` (`AlreadyExists` on slug), `findById`, `findBySlug`, `slugsLike`, `listPublished`, `setPublished` |
| `StaticContentRepository` | `find`, `upsert` (creates the block if missing) |
| `SponsorRepository` | `list`, `create` |
| `SocialEventRepository` | `list({ departmentId, semesterId })`, `create` |
| `PublicFileRepository` | `findByKey`, `findByLegacyPath`, idempotent `register` |
| `FileStore` | R2 `put` and `get` by content-addressed key |
| `Outbox` | `enqueue` typed `OutboxMessage`s (e-mail, Slack) in the current transaction |
| `AuditLog` | `record` one `AuditEntry` per staff write in the current transaction |

`storeUpload` also needs Effect's `Crypto.Crypto` (SHA-256); `apps/web` provides a Web Crypto implementation.

## Errors

A closed set: `NotFound`, `Forbidden`, `AlreadyExists`, `ValidationFailed` (`DomainError`). Infrastructure failures are defects.

## Transaction convention

Commands do not open transactions; atomic commands **require `InTransaction`**, and `packages/db` provides it by wrapping the program in `SqlClient.withTransaction`. `ensureCurrentSemester`, `storeUpload` and all queries run outside a transaction. Details and the full command table: [`src/README.md`](src/README.md).

## Commands

```
bunx vp test    # acceptance tests, named by rule id
bunx vp check   # format, lint, type check
```
