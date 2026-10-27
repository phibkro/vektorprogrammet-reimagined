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
| `guard.ts` | Native `Schema.makeFilter` semester checks (typed paths, after/same/not/or), `describe` (a check in words, down to the operands of a `not` or an `or`), and `SchemaRepresentation` revivers. Their JSON representations are available to compilers as well as the runtime. |
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
| `content` | C3, C5, C8 | the pure rules the public pages use (page size and order of news RULE-326/331, the sponsors' footer order), the rich-text sanitizer (RULE-133, run by the CMS importer), slugs, social events (RULE-085/188). Articles, static texts and sponsors live in the CMS since spec 0005 |
| `contact` | C10 | support ticket (RULE-156/327) and its notifications (RULE-249) |
| `files` | C11 | magic-byte typing (RULE-130), serving policy and registered-only access (RULE-290) |
| `audit` | C12 | `AuditEntry` (it records the principal: a person id or a job name), `AuditLog`, `recordAudit`, the `listAuditEntries` query |
| `outbox` | C12 | the `sweepOutbox` job command; its handler is in `apps/web` |
| `jobs`, `workspace` | spec 0008 | The closed registry and due rules; Workspace projection, report, read/write ports and commands. |

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

`Forbidden.command` is a string, as it is on the wire: the error sits below the declarations that give the names. A command that refuses on its own, for a rule that no grant row can state (never for oneself), builds the refusal with its domain's `forbidden` (`TeamsDomain.forbidden("createAdminGrant")`), whose parameter is the names of that domain's group and reads, so a renamed or misspelled command does not compile (spec 0007c R2). The code endpoints refuse with the command of the code's purpose, `codePolicy[purpose].command`, which the same parameter checks against the account domain.

## Transaction convention

Commands do not open transactions; atomic commands **require `InTransaction`**, and `packages/db` provides it by wrapping the program in `SqlClient.withTransaction`. `storeUpload` and all queries run outside a transaction. A command that writes a person's own rows takes the person's lock first (`AggregateLocks`, spec 0006b). Details and the full command table: [`src/README.md`](src/README.md).

## Tests

`@vektorprogrammet/domain/testing` exports the in-memory teams repositories (`TeamsInMemory`, `TeamTables`) for the tests of `apps/web`.

```
bunx vp test    # acceptance tests, named by rule id
bunx vp check   # format, lint, type check
```
