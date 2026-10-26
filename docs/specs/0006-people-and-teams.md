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
