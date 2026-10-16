# @vektorprogrammet/domain

Effect v4 domain core for Phase 1: pure rule functions, branded types, typed errors, capability-based authorization, service interfaces, and commands as Effect programs over those services. It depends only on `effect` and `sanitize-html`; it never imports `packages/db`, `apps/*`, Drizzle or SQL drivers.

## Bounded contexts (`src/`)

| Context | Capabilities | Contents |
| --- | --- | --- |
| `shared` | all | ids, `Actor`/`CurrentActor`, `Capability`/`authorize`, errors, Oslo clock helpers, `Outbox`, `InTransaction`, input decoding |
| `organisation` | C1, C2 | departments, fields of study, semesters (RULE-022/033/050/051/084/237), admission decisions (RULE-015/119), C1 commands, the semester job (`ensureScheduledSemesters`) and the pure semester reads (`currentSemester`, `findCurrentSemester`) |
| `content` | C3, C5, C8 | the pure rules the public pages use (page size and order of news RULE-326/331, the sponsors' footer order), the rich-text sanitizer (RULE-133, run by the CMS importer), slugs, social events (RULE-085/188). Articles, static texts and sponsors live in the CMS since spec 0005 (RULE-296 is its role model, RULE-070's countdown retired) |
| `contact` | C10 | support ticket (RULE-156/327) and its notifications (RULE-249) |
| `files` | C11 | magic-byte typing (RULE-130), serving policy and registered-only access (RULE-290) |
| `audit` | C12 | `AuditEntry`, `AuditLog`, `recordAudit` |

## Services

| Service | One line |
| --- | --- |
| `CurrentActor` | the request's `Actor` (`Anonymous` or `Staff`); provided per request by `apps/web` |
| `InTransaction` | proof that the program runs in a DB transaction; provided only by `packages/db`'s runner |
| `DepartmentRepository` | `list`, `findById`, `create`/`update` (`AlreadyExists` on unique city) |
| `SemesterRepository` | `list`, `find`, atomic `ensure` (RULE-237; only the scheduled job calls it, spec 0003) |
| `FieldOfStudyRepository` | `listByDepartment`, `findById`, `create`, `rename` |
| `AdmissionPeriodRepository` | `list` (read-only; the public pages ask which admission is open) |
| `SocialEventRepository` | `list({ departmentId, semesterId })`, `create` |
| `PublicFileRepository` | `findByKey`, `findByLegacyPath`, idempotent `register` |
| `FileStore` | R2 `put` and `get` by content-addressed key |
| `Outbox` | `enqueue` typed `OutboxMessage`s (e-mail, Slack) in the current transaction |
| `AuditLog` | `record` one `AuditEntry` per staff write in the current transaction |

`storeUpload` also needs Effect's `Crypto.Crypto` (SHA-256); `apps/web` provides a Web Crypto implementation.

`authorize` is the one answer to "may this actor do this?". Every command asks it through `requireCapability` (and refuses with `Forbidden`); `apps/web` asks the same function for the control panel's sidebar and for every control a page offers (spec 0004), so a control the actor may not use is not rendered. A role check in `apps/web` is a second list, and `apps/web/test/shell.test.ts` fails when a control and its command disagree.

## Errors

A closed set: `NotFound`, `Forbidden`, `AlreadyExists`, `ValidationFailed` (`DomainError`). Infrastructure failures are defects.

## Transaction convention

Commands do not open transactions; atomic commands **require `InTransaction`**, and `packages/db` provides it by wrapping the program in `SqlClient.withTransaction`. `ensureScheduledSemesters` (the semester job, spec 0003), `storeUpload` and all queries run outside a transaction. Details and the full command table: [`src/README.md`](src/README.md).

## Commands

```
bunx vp test    # acceptance tests, named by rule id
bunx vp check   # format, lint, type check
```
