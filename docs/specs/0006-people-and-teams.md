# Spec 0006: People and teams, and the declaration kernel

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 2 · **Source:** brief §7 "Information model and personal data" (accepted 2026-10-26); `docs/system/teams.md`; ADR 0001, 0002, 0006, 0007.

## Journey

1. **An admin** opens Team in the control panel, creates a team in a department with a function (board, economy, IT, recruitment, placement, other) and a default term (1 or 2 semesters), and registers a person (name, e-mail).
2. **A team leader** of that department adds the person to a team with a position. The membership gets an end semester from the team's default term; the leader can choose another end.
3. **The new member's control panel follows the membership.** A member of the department's recruitment or board team sees what that function allows; a person with no current membership sees no control-panel section. Nobody assigns a role.
4. **Four weeks before the semester ends**, each team leader gets an e-mail (a capture sink outside production) listing the memberships of their department that end this semester, each with a link to extend it.
5. **The leader extends** one membership, **changes** another member's position from next semester (the old membership ends, a new one starts; history shows both), and **ends** a third early. A member can end their own membership (resign).
6. **When the semester is over**, an ended membership gives no access, with no job and no flag: activity is calculated from the semester.

## Goal, constraints, values

- **Goal:** the first domain built entirely from declarations, and the kernel that every later domain reuses: transition tables (ADR 0007), commands declared with `effect/rpc` (ADR 0006), the grant table and subject sets (ADR 0001), and docs generated from them.
- **Constraints:**
  - **One authorization model.** `authorize` becomes a reading of the grant table. The Phase 1 capabilities (`CreateDepartment`, `UpdateDepartment`, `ManageFieldsOfStudy`, `ManageSocialEvents`, `UploadFiles`, `ReadAudit`) are re-expressed as commands with grants, and `StaffRole` and the role-based `Actor.Staff` shape are removed (clean cutover, no alias). The control-panel shell keeps deriving its sections from `authorize`.
  - **The actor is a person with facts.** `CurrentActor` becomes `Anonymous` or `Person { personId, memberships (active this semester, with team id, department id, function, leader), adminUntil? }`, loaded per request in one read before the program runs. Subject sets (`Member(d)`, `Leader(d)`, `Fn(f, d)`, `Board`, `Admin`, `Self`) are pure functions of these facts.
  - **No sign-in yet** (spec 0007 adds Better Auth). In `local`, the `vp-test-actor` cookie selects a seeded person by name; `preview` and `production` always yield `Anonymous`, as today.
  - **Admin list.** `AdminGrant { person, grantedBy, until }`. `grantAdmin` and `revokeAdmin` are admin-only, never on oneself, and the last grant valid after the current semester cannot be revoked or allowed to expire through `revoke`. The local seed holds one admin.
  - **Terms are data.** `Membership { person, team, position, leader, start: Semester, end: Semester }`; `end` is required (default `start + team.defaultTerm − 1`); `start ≤ end` and no overlap of one person's memberships in one team are database constraints. Active, Planned and Ended are calculated (`packages/domain`, pure), never stored.
  - **Transitions are conditional updates** inside the command transaction; a lost race is a typed conflict, never a silent overwrite. No advisory locks (Hyperdrive).
  - **Reads never write** (spec 0003): every new query is registered with the SELECT-only role test.
  - **The "ending soon" digest** runs in the existing `scheduled` handler beside the outbox sweep and the semester job, writes outbox rows, and is idempotent per leader and semester.
  - **Docs are generated.** `tools/docgen` renders, between markers, the Reference section of `docs/system/teams.md` (state diagram, commands and grants, subject sets) and the "Who does what" table from the declarations. `bun run check:docs` fails on any difference and is part of `ready` and CI.
- **Values:** one fact, one home. The grant table is at once the data of `authorize`, its test oracle and the table a board member reads.

## Declarations (the contract the kernel must express)

- `Machine.make({ states, transitions })` over a `Schema.TaggedUnion` of states: each transition `{ command, from: State[], to: State, guard? }`. `Machine.can(machine, command, state)` is pure. A transition to an undeclared state, or a command not in the domain's `RpcGroup`, is a type error.
- Commands: one `RpcGroup` per domain (`TeamsRpc`), each `Rpc.make(name, { payload, success, error })` annotated with its transition. Handlers via `RpcGroup.toLayer`; server functions decode and call an in-process client.
- Grants: `Grant.make(subjectSet, commands, scope)`, scope `own | department | all`; union only, no deny; `Admin` holds every command with `all` as one row.

## Behavior contract

| Rule | After |
| --- | --- |
| RULE-016, 023, 031, 048, 124 | One definition of an active membership: start ≤ current semester ≤ end |
| RULE-219, 263, 251, 252, 234 | No suspension flag or job; ended by date; `extend` is the only way to stay |
| RULE-206, 284 | `addMember` by `Leader(d) ∪ Board ∪ Admin` |
| RULE-298 | `endEarly` by `Leader(d) ∪ Board ∪ Admin`, or `Self` |
| RULE-157, 164 | Team name unique per department; member belongs to the team's department |
| RULE-321, 329, 233 | Teams created and edited within the actor's department; deactivated, never deleted |
| RULE-029, 030, 161, 163, 192, 194, 211, 213, 218, 275–279, 282, 300–305 | Retired: the grant table and deny by default replace roles and access rules |
| RULE-113, 308 | `grantAdmin`/`revokeAdmin`: admin only, never on oneself |

## Falsifiers (definition of done)

1. **`authorize` equals the grant table.** A property test over generated actors (memberships in random teams, functions, departments, admin grants) and commands shows `authorize` allows exactly the rows of the table. Deleting any one grant row makes it fail (negative control, checked in the test).
2. **Declarations are complete.** A test fails if a command has no grant, a grant names an unknown command, or a transition names a command not in its group.
3. **Concurrency.** Twenty concurrent `extend` and `endEarly` calls on one membership on real PostgreSQL leave a consistent row, and every loser gets the typed conflict.
4. **Constraints hold in the database.** Inserting an overlapping membership or `end < start` directly through SQL fails; dropping the constraint makes the test fail (negative control).
5. **Terms by date.** At the last instant of a semester a membership ending in it is Active; at the first instant of the next it is Ended (Europe/Oslo, RULE-022 boundaries).
6. **Admin list.** Self-grant, self-revoke and revoking the last valid grant are refused.
7. **Digest.** One run sends one message per leader with the memberships ending this semester; a second run sends none.
8. **Docs.** `check:docs` passes on the generated `teams.md`; changing one character in a generated block, or one grant row without regenerating, makes it fail.
9. **Reads never write.** Every new read path passes under the SELECT-only role.
10. **Browser journey.** Playwright: an admin creates a team and a person; a leader adds the member; switching the test actor to that member shows the sections the function allows; the leader extends, changes and ends memberships. CI is green, and the pull request's Worker Preview serves the Team page.

## Out of scope

Sign-in, invitations and personal-data mechanisms (spec 0007); Google group projection (spec 0008); retiring the social-events page (ADR 0005, its own slice); importing legacy teams and memberships (spec 0013).

## Revisions

### R1 (2026-10-26): principals

Operator input, relayed by the lead. It changes the vocabulary and adds one kind of acting party. Everything else in this spec stands.

1. **The acting party is a principal, not an actor.** `CurrentPrincipal` replaces `CurrentActor`. Its value is `Anonymous`, `Person { personId, memberships, adminUntil? }` or `System { job }`, where `job` is `"semesters"`, `"outboxSweep"` or `"endingSoon"` (a closed set that later slices extend). "Actor" in the Constraints above reads "principal".
2. **A grant may name `System(job)` as its subject set.** The scheduled jobs run as their `System` principal through the same `authorize` path, so no job bypasses it: `ensureSemesters` is granted only to `System("semesters")`, `sweepOutbox` only to `System("outboxSweep")` and the ending-soon digest `sendEndingSoon` only to `System("endingSoon")`. `Admin` holds every command that a person may run, which excludes the commands that only a job runs.
3. **Every audit row records the principal:** a person id or a system job name, never both. Session and device fields come with sign-in (spec 0007).
4. **The grant property test (falsifier 1) and the completeness test (falsifier 2) include `System` principals.** A job that holds no grant is refused like any other principal.

### R2 (2026-10-26): what the build showed

Found while building the kernel and the teams domain; none of it changes a falsifier.

1. **`Machine.make` takes the domain's `RpcGroup`** (`Machine.make({ name, commands, states, transitions })`), so a transition that names a command outside the group is a compile error, as the Declarations section asks, and not only a failing test. A transition's guard reads a typed context (the term, the current semester, the semester the command names); `Machine.can(machine, command, state, context)`. Active, Planned and Ended are calculated, so the machine also lists the changes that time makes (`calculated`), and the generated diagram shows them.
2. **Reads are named permissions.** A page or a list that a grant guards without a command (`openControlPanel`, `viewTeams`, `viewPeople`) is declared as a `read` of its domain and carries rows like a command, so the control panel asks `authorize` and nothing else. The grant table is typed by the names of the commands and reads of its domain.
3. **`Admin` is one row.** Each domain adds no admin row of its own to the root table: `declarations.ts` builds the single `Admin` row, scope `all`, that names every command and read that a person may run (a job's command is in no person's row).
4. **`registerPerson` is granted for the department of the chosen field of study.** A person has a required field of study (RULE-164: a member belongs to the team's department, and the department comes from the field of study, as in the legacy data). `registerPerson` is therefore a `Leader(d) ∪ Board(d) ∪ Admin` command for the department of that field. A cross-department `change` is the explicit exception to RULE-164 and needs the grant in both departments in the same transaction.
5. **The position value list is a table**, seeded by the migration with `Leder` and `Medlem` (the legacy fixtures), so a later slice can extend it without a deploy.
6. **`ReadAudit` is the real command `readAudit`** of the audit domain, granted through the `Admin` row only. `sweepOutbox` is declared in its own `outbox` domain with no person's grant; its handler lives in `apps/web`, where the transports are.
7. **`Conflict` joins the typed errors.** A transition that could not be applied (the membership is not in a state the command starts from, or the conditional update found it changed) is `Conflict`, mapped to HTTP 409 beside `AlreadyExists`.
8. **Server functions call `Commands.endpoint`.** It decodes untrusted input with the command's payload schema and calls the handler through the in-process client, inside the caller's `Transactor.run` (design: one transaction for the handler, its audit row and its outbox rows).
9. **The ending-soon link** is `${SITE_URL}/kontrollpanel/team/<teamId>?forleng=<membershipId>`; `SITE_URL` is a Worker setting (a production deployment declares it, the local one derives it from the dev server). The digest goes to team leaders only, as the journey says; the admin digest of the information model is a later slice.
10. **A member's own resignation** is `endEarly` granted to `Self`, scope `own`. `canAnywhere` does not count `own` rows, so the sidebar never offers a page for them alone; a member reaches the control on the Team page, which `viewTeams` opens to every member of the department, beside their own membership. The browser journey exercises the leader's `endEarly`.

### R3 (2026-10-26): the database

1. **A membership's term is four columns and two generated ones.** `start_term`, `start_year`, `end_term`, `end_year`, and the generated `start_ordinal` and `end_ordinal` (`year * 2 + (term = HOST)`). `start ≤ end` is the check `membership_term_order` on the ordinals. No overlap is the exclusion constraint `membership_no_overlap` on `(person_id =, team_id =, int4range(start_ordinal, end_ordinal, '[]') &&)`. Drizzle cannot model an exclusion constraint, so it is a custom migration, and it needs `btree_gist` (a trusted extension: the migration creates it, PGlite loads it in the tests).
2. **A person has no stored department.** The department of a person is the department of their field of study, joined when read, so the two cannot disagree.
3. **The audit trail names the principal in two nullable columns**, `person_id` and `system_job`, and a check keeps exactly one of them set. The existing `actor_id` column is renamed `person_id` (the migration keeps every existing row). There is no foreign key, so the trail outlives whatever it names.
4. **The importer's truncate lists the tables built on its own** (`team`, `person`, `membership`, `admin_grant`, `ending_soon_digest`), because PostgreSQL refuses to truncate a referenced table unless the referencing one goes with it. A re-import clears people and teams until spec 0013 imports the legacy teams and memberships and takes over the list. The position value list is not cleared: the migration seeds it.
5. **The local seed is a script, `bun run db:seed:local`** of `packages/db` (`SEED_TARGET_DATABASE_URL`, else `DATABASE_URL`): Ada Admin (an admin place), Lise Leder (leads the recruitment team), Mats Medlem, Sofie Styre (the board team), Nora Nybegynner (no team) and Eva Ekstern (an ended membership), in the first department that has a field of study. The browser tests run it after the importer's fixture. It is safe to run again.

### R4 (2026-10-26): native checks as guard data

The lead requires guards to be serializable so later Alloy and Quint generators can consume the same declarations as the runtime, without a second guard definition.

1. **Guards are Effect Schema checks**, not opaque predicates. A machine declares its context schema, and each transition's `guard` is a `Schema.makeFilter` or `Schema.makeFilterGroup` check on that context. `Machine.can` uses `Schema.is` on the checked schema. The Membership context names the already-validated term, current semester and requested semester; its operand paths are typed against that context.
2. **Checks have representations.** The semester comparisons use the closed identifiers `vektorprogrammet/semester/after` and `/same`; negation and disjunction use `/not` and `/or`. Their representation payloads identify operand paths, and logical checks carry their child schemas. The all-of check is `Schema.makeFilterGroup`. `Machine.Description` exposes each guard's JSON representation and a label when none was declared.
3. **Serialization is Effect's.** `SchemaRepresentation.toRepresentation` and `toJson` export a checked context; `fromJson` and `fromRepresentation`, supplied with the kernel's `makeReviverFilter` revivers and the relevant Effect built-in revivers, restore its runtime checks. Generated-context round-trip tests cover every Membership guard, and changing `after` to `same` is a negative control.

### R5 (2026-10-27): web presentation and local origin

1. `Machine.startsFrom` identifies the controls a state can offer before a person enters a command. A change or early-end form is absent when its semester list would be empty.
2. The database package exports the local people and the default name. The seed and the test-actor switch share these names. A signed-in person with no current grant sees the no-sections page.
3. Local `SITE_URL` is explicit rather than inferred from Vite. Set it to the local web origin to generate absolute digest links. The browser harness supplies its chosen origin. Preview has a capture sink and an empty origin; production requires `SITE_URL`.

### R6 (2026-10-27): the person's row lock orders overlapping writes

Found by an intermittent failure of the two-overlapping-inserts test (about 6 in 1,000 rounds under load, `deadlock_detected`, SQLSTATE 40P01, instead of `23P01`). The contract is unchanged: an overlapping membership is `AlreadyExists`; a lost race on a transition is `Conflict`.

1. **Why.** PostgreSQL writes the exclusion constraint's index entry before it checks it. Two overlapping writes of one person that start together each find the other's uncommitted entry and wait for its transaction, so one of them is aborted as a deadlock victim. That abort is not a verdict on the data: the survivor can still roll back. Mapping 40P01 to `AlreadyExists` would be a guess, so `classifySqlFailure` still leaves it a defect.
2. **The fix removes the race, not the constraint.** `MembershipRepository.insert` and `setEnd` (the two writes that can raise `membership_no_overlap`) first take `SELECT … FOR NO KEY UPDATE` on the person's row. The second write waits before it writes anything, then meets the committed row (refused by the constraint, `AlreadyExists`) or a rolled-back one (succeeds). A row lock is not an advisory lock (ADR 0007 still holds), and no foreign-key check conflicts with it. Every writer that can raise the violation takes the lock first, so the lock order is the same everywhere.
3. **Tests.** `teams.postgres.test.ts` repeats the insert/insert race and an extension/insert race for hundreds of rounds, and asserts each loser's typed error with its full cause as the message. A second test holds the person's row lock in an open transaction and shows that an insert waits for it. A unit test pins that `DeadlockError` stays a defect.

### R7 (2026-10-27): a read the principal does not hold is refused, not served empty (issue 15)

Found when a plain member (no `viewPeople`) got `200` and an empty list on `/kontrollpanel/personer` while the sidebar hid the page. R2.2 made the read a named permission; this revision makes the response follow it. The operator's decision: not having read access means no 2xx when fetching.

1. **The rule.** Every control-panel read server function is served exactly when the principal may open the page's section, the predicate the sidebar uses (`canAnywhere` over the section's commands and reads); otherwise it answers `Forbidden` (403, the refusal an anonymous principal gets), before any row is read, so a missing team and an existing one look the same. Row-level filtering by scope stays underneath. `getShell` is the sidebar itself and answers everyone with the sections they may open.
2. **One declaration.** `apps/web/src/server/panelAccess.ts` maps each section to its commands and reads (`SECTION_COMMANDS`) and each read server function to its section (`READ_SECTIONS`). The sidebar (`server/shell.ts`) and the guard (`server/panelReads.ts`, which every GET server function runs) both read it; the per-view `requireGrant` calls that repeated it were removed. There is no second list and no role check in `apps/web`.
3. **Tests.** `apps/web/test/panelReads.test.ts` runs every read as every kind of principal (anonymous, each `System` job, a member and a leader of every team function, an administrator, a person with an ended or not-yet-begun membership, a leader of another department) and compares the status with the sidebar; it names the people-page case for a member without `viewPeople`; and its negative controls remove the guard from each read in turn and must fail. Source-scan tests fail on a GET server function that is not a guarded read and on a route whose loader calls a read of another section. `e2e/shell.spec.ts` sends the same requests over HTTP. `readsNeverWrite.postgres.test.ts` runs the guarded programs.
