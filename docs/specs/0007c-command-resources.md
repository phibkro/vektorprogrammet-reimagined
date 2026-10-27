# Spec 0007c: every command names its resource and method

Status: frozen 2026-10-27. Operator decision: ADR 0010 (`../decisions/0010-commands-carry-their-resource-method.md`, "every command names its resource and method; the HTTP API is derived from that"). Builds on main `79bbecf`. Spec 0007b (personal data) declares its commands in this shape.

## Journey

A developer adds a command, and the kernel does not let a vague one through.

1. They write `Rpc.make("approveExpense", …).annotate(Info, info({ summary: "…" }))`. **`vp check` refuses it**: `resource` and `method` are required fields of `info`.
2. They write `resource: "Expense"`. **Refused again**: a resource is one of a closed set, so the noun is declared first (an entity in `EntityName`, or a noun that no error or audit row names in `NonEntityResources`), and a typo cannot become a second noun.
3. They write `method: "update"` for a command that moves a state machine. **The completeness test refuses it**: `approveExpense is declared update, but …` and names the transition. They choose the custom verb `":approve"` instead, which says the intent that a standard method would blur.
4. They name the command `release` but declare it `":approve"`. **Refused**: a custom method's name starts with its verb (`approveExpense`), so the name and the method cannot say different things.
5. They run `bun run docs`. `docs/system/commands.md` now lists `approveExpense` under its resource, `Expense`, with its method, its domain and who may run it, next to every other command that touches the same resource, whichever domain declares it.

A reader opens `docs/system/commands.md` to answer "what can be done to a membership?" and finds all of it in one place: `createMembership`, `extendMembership`, `changeMembership`, `endEarlyMembership`, `deleteMembership`, each with its method.

## Problem

ADR 0010 settles that each command carries a resource and a method, and that existing names move to the convention. The kernel does neither yet:

1. **A command declares what it is called, not what it acts on.** `extend`, `change`, `cancel`, `activate` and `deactivate` are bare verbs. Two domains may both want `cancel`; the tag is the key of the grant table, so a collision would merge two commands' grants instead of failing.
2. **An HTTP API or an OpenAPI document cannot be derived** (ADR 0010, effx spec 0031 §3.2a), because the fact it derives from does not exist. When it is needed, someone would design it by hand, beside the declarations, and the two would disagree.
3. **The docs list commands by domain only.** What can be done to a person is split between `teams.md` and `accounts.md`, and `organisation`, `content`, `files`, `contact`, `audit` and `outbox` have no generated reference at all.

## Goal

Every command declares, once, the **resource** it acts on and the **method** it uses. Everything that follows from the pair (the command's name, the kind of command it is, what its transitions may do, the page that lists it) is checked against it or generated from it.

## Constraints

1. **A closed set, not a free string.** `resource` is a type whose values are the domain's own nouns. A new noun is a deliberate edit in one place.
2. **Compile-time first.** A command without a resource or a method does not type-check. The completeness test covers what the types cannot say (naming, transitions, uniqueness, an annotation that is missing altogether).
3. **No claim of `412`.** A stale `If-Match` answers `412` only when a row version exists (ADR 0010), and none exists. The method has no field that could promise one, so an `update` cannot promise what no column can keep. The day a version column is added, the `update` method gains that field in the same change as the check that needs it.
4. **One mechanical rename, no aliases.** Every caller moves with the name: grant rows, machine tables, handlers, endpoints, server functions' calls, tests, docs. The audit log keeps its own vocabulary (`AuditAction`, a persisted column with a `CHECK`), which this spec does not touch.
5. **No new infrastructure.** No migration, no new dependency, no change to a handler's behaviour.

## Values

Correctness by construction (a vague command is unrepresentable, not detected); one source of truth (the pair is stated once, and the name, the checks and the docs read it); generate before test before convention.

## Contract

### 1. The field

In `packages/domain/src/kernel/commands.ts`, `CommandInfo` gains two required fields and `info({ … })` takes them:

| Field | Type | Meaning |
| --- | --- | --- |
| `resource` | `Resource` = `EntityName` ∪ `NonEntityResources` (`AuditEntry`, `OutboxMessage`, `SupportTicket`) | What the command acts on: the noun of AIP-121 |
| `method` | `"get" \| "list" \| "create" \| "update" \| "delete"` or a custom verb written `":verb"` | How, after AIP-131 to AIP-136; the verb is lowerCamelCase: `":extend"` |

`EntityName` (`shared/ids.ts`) is the existing closed set of the aggregates that errors and audit rows name, and it stays the single list of entities. A noun that no error or audit row names (the audit log's entries, the outbox's messages, a contact message) is listed once, beside the type, in `NonEntityResources`; adding it to `EntityName` would widen the `CHECK` on `audit_log.entity` and need a migration for a value that no row can hold. Reads (`reads: { viewPeople: … }`) are guarded page names with no handler and are not API operations, so they carry no pair.

### 2. What the pair fixes

- **The name.** `create`, `update`, `delete`, `get`: the tag is exactly the verb followed by the resource (`createTeam`, `updatePerson`, `deleteAdminGrant`). `list`: the tag starts with `list` (a collection's noun is plural, and the kernel keeps no plural table). A custom method: the tag starts with its verb (`extendMembership` for `":extend"`; `requestPasswordReset` for `":requestPasswordReset"`). The check does not make a custom name carry its resource: `requestPasswordReset` and `sweepOutbox` carry their object in the verb phrase, and a bare verb (`extend`) passes the check. This spec's rename gives each bare verb its resource, and the generated page puts every command beside its resource, where a review reads it.
- **The kind.** `get` and `list` are queries and the rest are commands. A query changes nothing, so a command that applies a machine, is a job's, or is a credential's is never `get` or `list`.
- **The transitions** (ADR 0010): a `create`'s transitions all start from `[*]`; a `delete`'s all end in `[*]`; an `update` changes no state (each transition leaves the machine where it was). A custom method has no such rule: it is the method for an intent that a standard one would blur.
- **Uniqueness.** No two commands, in any domain, share a resource and a method; no two share a tag. (The HTTP shape that ADR 0010 derives would otherwise be one route twice.)

### 3. The standard method is the default

A command is a standard method when it is the one way that its resource is created, changed in its fields, read or removed. It is custom when a standard method would blur it (ADR 0010): several commands would be the same `update` and differ in audit meaning or transition (`deactivateTeam` beside `updateTeam`), it moves a state (`activateAccount`), it acts on many rows (`sweepOutbox`, `sendEndingSoon`), it ensures what the calendar says should exist (`ensureSemesters`), it stores nothing that it names (`submitContact` queues mail and creates no ticket), or it consumes a credential (`resetPassword`).

### 4. The rename

The same pair gives every command its name. Seventeen move; twelve already conform.

| Domain | Was | Is | Resource | Method | Why this method |
| --- | --- | --- | --- | --- | --- |
| organisation | `createDepartment` |  | `Department` | `create` |  |
|  | `updateDepartment` |  | `Department` | `update` |  |
|  | `createFieldOfStudy` |  | `FieldOfStudy` | `create` |  |
|  | `renameFieldOfStudy` | `updateFieldOfStudy` | `FieldOfStudy` | `update` | ADR 0010 |
|  | `ensureSemesters` |  | `Semester` | `":ensure"` | a job: idempotent, creates the missing current and next semester |
| teams | `createTeam` |  | `Team` | `create` |  |
|  | `editTeam` | `updateTeam` | `Team` | `update` | ADR 0010 |
|  | `deactivateTeam` |  | `Team` | `":deactivate"` | a second change of a team's fields, with its own audit meaning |
|  | `registerPerson` | `createPerson` | `Person` | `create` | the one way a person is created |
|  | `addMember` | `createMembership` | `Membership` | `create` | a transition from `[*]` (ADR 0010's `POST /teams/{team}/memberships`) |
|  | `extend` | `extendMembership` | `Membership` | `":extend"` | ADR 0010 |
|  | `change` | `changeMembership` | `Membership` | `":change"` | ends one membership and starts another |
|  | `endEarly` | `endEarlyMembership` | `Membership` | `":endEarly"` | ADR 0010; its own grant (`self`) |
|  | `cancel` | `deleteMembership` | `Membership` | `delete` | the one transition into `[*]`: a membership that has not started is removed |
|  | `grantAdmin` | `createAdminGrant` | `AdminGrant` | `create` |  |
|  | `revokeAdmin` | `deleteAdminGrant` | `AdminGrant` | `delete` | ADR 0010 |
|  | `sendEndingSoon` |  | `Membership` | `":sendEndingSoon"` | a job that mails a digest of many rows |
| accounts | `invite` | `createAccount` | `Account` | `create` | the Account machine's one transition from `[*]` |
|  | `activate` | `activateAccount` | `Account` | `":activate"` | consumes its code; a state change |
|  | `requestPasswordReset` |  | `Account` | `":requestPasswordReset"` | a credential flow, by e-mail address |
|  | `resetPassword` |  | `Account` | `":resetPassword"` | consumes its code |
|  | `deactivate` | `deactivateAccount` | `Account` | `":deactivate"` | ADR 0010 |
|  | `reactivate` | `reactivateAccount` | `Account` | `":reactivate"` | a state change |
|  | `updateProfile` | `updatePerson` | `Person` | `update` | ADR 0010's `PATCH /people/{person}` |
| content | `createSocialEvent` |  | `SocialEvent` | `create` |  |
| files | `registerPublicFile` | `createPublicFile` | `PublicFile` | `create` | the one way a public file is created; its key is its content hash, so a retry is harmless |
| contact | `submitContact` |  | `SupportTicket` | `":submit"` | stores no ticket: it queues the mail |
| audit | `readAudit` | `listAuditEntries` | `AuditEntry` | `list` | the only query |
| outbox | `sweepOutbox` |  | `OutboxMessage` | `":sweep"` | a job that delivers many rows |

A name that was already a verb and its object (`createTeam`, `requestPasswordReset`, `sweepOutbox`) is not renamed.

### 5. The documents

`tools/docgen` renders `docs/system/commands.md`, **every command by resource**, from all the declarations: one block per resource that has commands, in the order of the closed set, each row with the command, its method, its domain, what it does and to whom it is granted. Within a resource, the standard methods come first in the order `get`, `list`, `create`, `update`, `delete`, then the custom ones as declared. The command tables of `teams.md` and `accounts.md` gain the same two columns. `docgen` refuses to render when any declaration is incomplete, as it does today.

## Falsifiers

1. **Types.** `info({ summary })` does not type-check, nor does a `resource` outside the set, nor a `method` that is neither a standard method nor a colon verb (type tests in `packages/domain/test/kernel/resourceMethod.test.ts`, no suppression). Negative control: make `resource` optional in `info` and the test fails.
2. **Real declarations.** The completeness check passes on `Declarations`: every command has a pair, names, kinds and transitions agree, and no pair or tag repeats.
3. **Each check has a negative control**, a one-line change of the sample domain that makes exactly that check report: a command without its `Info` annotation; a custom verb that is not lowerCamelCase; a standard method with the wrong tag (`editTeam` as `update Team`); a custom method whose tag does not start with its verb; a `list` on a command that applies a machine, on a job's command and on a credential's; a `create` with a transition from a state; a `delete` ending in a state; an `update` that changes a state; two commands with one resource and method; one tag in two domains.
4. **The rename.** `vp check` passes (every typed caller moved: grant rows, machine tables, handlers, endpoints, authorizations); the domain, db and web tests pass; no old name from the table survives as a command in code, tests or docs (search evidence in the PR).
5. **Documents.** `bun run check:docs` passes on the committed pages. Negative controls: one changed character in a generated block fails; a command moved to another resource in its declaration without regenerating fails; an incomplete declaration is refused; invalid markers are refused.
6. `bun run ready` passes, and so does the browser suite (`bun run e2e`).

## Out of scope

- **The HTTP API.** ADR 0010 derives it later (effx spec 0031), only when a client outside the web app needs it. This spec adds the fact it derives from, and no route, path pattern or collection name.
- **Row versions.** `update` stays without a `412` until a version column exists (constraint 3).
- **Reads.** Named reads are guarded pages and carry no pair.
- **Audit names.** `AuditAction` is a persisted vocabulary and stays as it is.
- **The names of the web's server functions**, which are the control panel's own vocabulary (`saveTeam`, `cancelMembership`); they call the renamed commands.

## Revisions
