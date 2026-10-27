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
| `guard.ts` | Native `Schema.makeFilter` semester checks (typed paths, after/same/not/or), `describe`, and `SchemaRepresentation` revivers. Their JSON representations are available to compilers as well as the runtime. |
| `machine.ts` | `Machine.make` (transition tables over a `Schema.TaggedUnion` of states and a context schema, typed by the domain's `RpcGroup`), `can`, `startsFrom`, `available`, `next`. Guard checks are compiled once; their JSON is exposed in machine descriptions. Calculated transitions are declared, not stored. |
| `commands.ts` | `Info` (the annotation each `Rpc` carries: summary, the legacy rules it replaces, the job that alone runs it, its machine), `inProcess` (the group's handlers behind a client in this process) and `endpoint` (untrusted input in, the command's own result out). |
| `domain.ts` | `Domain.make({ commands, reads, grants, machines })`, `handle` and `problems`. It also exposes the existing command metadata, grant constructor and subject sets for declarations. `departmentResource` selects the department from a command payload. |

`declarations.ts` lists every domain and builds `GrantTable` (the rows of all domains, and the one `Admin` row that names everything a person may run) and the root `authorize` and `canAnywhere`. A domain that is not in that list has no permissions and no page.

A principal is a person with facts, never a role (ADR 0001). The scheduled jobs run as their own `System` principal through the same `authorize`: `ensureSemesters` is granted only to `System("semesters")`, `sweepOutbox` only to `System("outboxSweep")` and `sendEndingSoon` only to `System("endingSoon")`. No person holds a job's command, an admin included.

## Bounded contexts (`src/`)

| Context | Capabilities | Contents |
| --- | --- | --- |
| `kernel`, `shared` | all | the kernel above; ids, errors (`NotFound`, `Forbidden`, `AlreadyExists`, `Conflict`, `ValidationFailed`), Oslo clock helpers, `Outbox`, `InTransaction`, `SiteOrigin`, input decoding |
| `organisation` | C1, C2 | departments, fields of study, semesters (RULE-022/033/050/051/084/237), admission decisions (RULE-015/119), the `OrganisationRpc` commands, the semester job (`semesterJob`) and the pure semester reads (`currentSemester`, `findCurrentSemester`) |
| `teams` | spec 0006 | `Person`, `Team`, `Position`, `Membership` (a term of two semesters, its state calculated in `term.ts`), `AdminGrant`; the `TeamsRpc` commands and the Membership machine; the ending-soon digest (`endingSoon.ts`) |
| `accounts` | spec 0007 | The Account machine, `AccountRpc`, password policy, single-use Code and request-scoped code principals. [Account reference](../../docs/system/accounts.md). |
| `content` | C3, C5, C8 | the pure rules the public pages use (page size and order of news RULE-326/331, the sponsors' footer order), the rich-text sanitizer (RULE-133, run by the CMS importer), slugs, social events (RULE-085/188). Articles, static texts and sponsors live in the CMS since spec 0005 |
| `contact` | C10 | support ticket (RULE-156/327) and its notifications (RULE-249) |
| `files` | C11 | magic-byte typing (RULE-130), serving policy and registered-only access (RULE-290) |
| `audit` | C12 | `AuditEntry` (it records the principal: a person id or a job name), `AuditLog`, `recordAudit`, the `readAudit` command |
| `outbox` | C12 | the `sweepOutbox` job command; its handler is in `apps/web` |

## Services

| Service | One line |
| --- | --- |
| `CurrentPrincipal` | the acting party; provided per request (a person) or per job (`System`) by `apps/web` |
| `InTransaction` | proof that the program runs in a DB transaction; provided only by `packages/db`'s runner |
| `DepartmentRepository` | `list`, `findById`, `create`/`update` (`AlreadyExists` on unique city) |
| `SemesterRepository` | `list`, `find`, atomic `ensure` (RULE-237; only the scheduled job calls it, spec 0003) |
| `FieldOfStudyRepository` | `listByDepartment`, `findById`, `create`, `rename` |
| `AdmissionPeriodRepository` | `list` (read-only; the public pages ask which admission is open) |
| `PersonRepository`, `TeamRepository`, `PositionRepository` | people, teams (unique name per department, deactivated and never deleted), the position value list |
| `MembershipRepository` | reads, `insert` (no overlap: `AlreadyExists`), and the conditional `setEnd` and `remove` (a lost race is a `Conflict`) |
| `AdminGrantRepository` | the admin list; `revoke` refuses the last place that ends after the current semester, atomically |
| `AccountRepository`, `CodeRepository`, `PasswordHasher` | Account state, conditional code use and the bcrypt boundary. |
| `DigestLedger` | one row per leader and semester: the digest goes out once |
| `PrincipalDirectory` | loads a person's facts in one read (`apps/web` uses it to build the principal) |
| `SocialEventRepository` | `list({ departmentId, semesterId })`, `create` |
| `PublicFileRepository` | `findByKey`, `findByLegacyPath`, idempotent `register` |
| `FileStore` | R2 `put` and `get` by content-addressed key |
| `Outbox` | Enqueues e-mail, Slack and account-delivery intents in the current transaction. |
| `AuditLog` | `record` one `AuditEntry` per write in the current transaction, `latest` |
| `SiteOrigin` | the origin that the links in messages carry |

`storeUpload` also needs Effect's `Crypto.Crypto` (SHA-256); `apps/web` provides a Web Crypto implementation.

`authorize` is the one answer to "may this principal do this?". Every command handler is built with its domain's `handle`, which asks the table before the command runs (and refuses with `Forbidden`); `apps/web` asks the same function for the control panel's sidebar and for every control a page offers (spec 0004), so a control the principal may not use is not rendered. A role check in `apps/web` is a second list, and `apps/web/test/shell.test.ts` fails when a control and its command disagree.

## Errors

A closed set: `NotFound`, `Forbidden`, `AlreadyExists`, `Conflict`, `ValidationFailed` (`DomainError`). A `Conflict` is a transition that could not be applied: the resource is not in a state that the command starts from, or it changed between the read and the conditional update. Infrastructure failures are defects.

## Transaction convention

Commands do not open transactions; atomic commands **require `InTransaction`**, and `packages/db` provides it by wrapping the program in `SqlClient.withTransaction`. `storeUpload` and all queries run outside a transaction. Details and the full command table: [`src/README.md`](src/README.md).

## Tests

`@vektorprogrammet/domain/testing` exports the in-memory teams repositories (`TeamsInMemory`, `TeamTables`) for the tests of `apps/web`.

```
bunx vp test    # acceptance tests, named by rule id
bunx vp check   # format, lint, type check
```
