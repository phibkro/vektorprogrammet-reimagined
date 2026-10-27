---
status: proposed
---

# Units, roles and decisions

The organisation is a tree of **units**. A **role assignment** puts a person in a role kind in one unit for a term. A **decision rule** says how a unit decides, and a passed **decision** is the authority for a command and the audit record of it. Role kinds and decision rules are declared in code. Labels and decisions are data. Only role kinds and passed decisions grant anything.

The accepted design has departments, teams, schools and sponsors as separate things, a membership that joins a person to a team, and an admin list beside it. They have the same shape: a group of persons, a person's place in it, and a rule for who may change that. The current spec 0006 grants team-membership commands to `Leader(d) ∪ Board` for a department. The legacy system let any team leader add members; its routes did not check departments (RULE-284). Spec 0006 added a department-wide scope, so a leader of one team can add members to every team in the department. Nothing records how a team decides, and "leader decides" is only a habit.

## Units

A **unit** (enhet) is an organisational grouping of persons: Vektorprogrammet, a department, a team, the board, a school or a sponsor.

- Units form a tree. Each unit except the root has one parent. Vektorprogrammet is the root.
- A unit gets its parent when it is created, and the parent must already exist. So a cycle cannot be written. Each unit kind declares the kinds that it may sit under.
- The kinds are `Vektorprogrammet`, `Department`, `Team`, `School` and `Sponsor`. The board is a team whose function is `board` (ADR 0001). School and Sponsor are external units: their people are not Vektorprogrammet's own.
- A Unit is not a DDD aggregate or a lock root. Spec 0006b decides which existing root guards each write.

| Unit kind | Parent kinds | Example |
| --- | --- | --- |
| Vektorprogrammet | none (root) | Vektorprogrammet |
| Department | Vektorprogrammet | NTNU |
| Team | Vektorprogrammet, Department | Styret (board), IT, the national board (hovedstyret) |
| School | Department | A lower secondary school that a department places assistants in |
| Sponsor | Vektorprogrammet, Department | A company that funds a department |

## Role kinds and role assignments

A **role kind** (rolletype) is declared in code, per unit kind, and carries privileges through the grant table (ADR 0001). A role kind never changes at run time.

| Unit kind        | Role kinds (first set)      |
| ---------------- | --------------------------- |
| Vektorprogrammet | `member`, `leader`, `admin` |
| Department, Team | `member`, `leader`          |
| School, Sponsor  | `contact`                   |

A **label** (etikett) is display text on a role assignment: "Nestleder", "Medlem", "Kasserer". Labels are run-time data. A label never grants anything. Authorization code receives role kinds only, and the type of its input has no label in it, so a check cannot read one.

A **role assignment** is a person, a role kind, a unit and a term (ADR 0002). It generalises the membership. The admin list becomes the `admin` role on the Vektorprogrammet unit. Role kinds have an order within their unit kind. On the root, `admin` is the highest role kind; only an Admin grants `admin`. Elsewhere, `leader` is above `member`.

**Member of Vektorprogrammet** is not stored. It is true while a person has a current placement or a current `member` or `leader` assignment in an internal unit (`Department` or `Team`). A `contact` assignment on a School or Sponsor is not an engagement in Vektorprogrammet. External contacts do not become members, and they do not enter the alumni lifecycle. The `member` role kind on the root exists so that a grant can name it; nobody assigns it.

## Subject sets

The subject sets of ADR 0001 follow from role assignments. Sets of one team take the team from the command's resource.

| Subject set | Meaning | Replaces |
| --- | --- | --- |
| `TeamMember(t)` | A current role assignment of kind `member` or `leader` in team `t` | `Member(d)`, narrowed to one team |
| `TeamLeader(t)` | A current role assignment of kind `leader` in team `t` | `Leader(d)`, narrowed to one team |
| `Member(d)`, `Leader(d)` | Derived: `TeamMember(t)` or `TeamLeader(t)` for some team `t` in department `d` | stay, with this definition |
| `Fn(f, d)`, `Board` | Unchanged |  |
| `Admin` | A current `admin` role assignment on the Vektorprogrammet unit | the admin list |
| `Link(purpose)` | The principal presenting a single-use link credential for purpose `purpose`, restricted to its command and person | `Holder(p)` |
| `Self`, `Anyone`, `System(job)` | Unchanged |  |

**Applicant** is a lifecycle status (spec 0009), not a role. Roles can overlap, and each step from applicant towards a role in a unit needs an approval.

## Who grants a role

Only a unit itself, by its decision, or an Admin can put a person into that unit. The same holds for the board. A leader of team `a` has no power over team `b`.

"Leader status in team `t`" is `TeamLeader(t) ∪ Admin`. This replaces spec 0006's department-wide `Leader(d) ∪ Board` grants on memberships. The rows that change:

| Command | Today | Proposed |
| --- | --- | --- |
| `createMembership`, `extendMembership` (team `t`) | `Leader(d) ∪ Board`; `Admin` | a decision of `t` (default: `TeamLeader(t)` decides); `Admin` |
| `changeMembership` (from `t1` to `t2`) | `Leader(d) ∪ Board`; `Admin`, and the grant in the receiving department | `TeamLeader(t1) ∪ Admin` for the end, and a decision of `t2` or `Admin` for the start, in one transaction |
| `endEarlyMembership` | `Leader(d) ∪ Board`; `Self`; `Admin` | `TeamLeader(t)`; `Self`; `Admin` |
| `deleteMembership` (not started) | `Leader(d) ∪ Board`; `Admin` | `TeamLeader(t)`; `Admin` |

Other grants that use `Leader(d)` or `Board` (create, update and deactivate a team, register a person, see people, accounts, admission, placement) keep their rows. Whether they become unit-bound is open (see Open questions).

An Admin acts on the authority of the `Admin` grant. The audit entry names that grant, not a decision. Admin grants are exempt from the no-escalation check. Only an Admin can grant the root's `admin` role.

## Renewal

Renewal makes membership feel persistent to the person, while the system keeps a sequence of explicit temporary terms. A **renewal plan** is an option on a role assignment: its interval (`semester` or `year`), a mandatory latest end date (the cap), and whether it is on. The same decision that grants the role assignment approves its plan. Each role kind declares its cap once; the decision sets the assignment's latest end date from that declaration. A role kind without a declared renewal interval does not renew automatically. A renewal is not a new decision.

The operator has decided the defaults: a five-year cap; a `member` interval of one semester; a `leader` interval of one year; and no automatic renewal for `admin`. A leader's renewal cannot outlast that leader's own term. After an assignment reaches its cap, continuing needs a new decision.

One interval before a term ends, `System(renewals)` runs `extendMembership` under its own grant. At that step it checks that the person's account is Active, the unit is active, the plan is still on, and the next end date stays within the cap. If a check fails, no extension occurs and the term ends on its current end date. The renewal takes the Person lock, like `extendMembership`; `Person`-owned reads and writes go through that token (spec 0006b).

The person can stop the plan from Min side, and a leader of the unit can stop it, at any time without a decision. Stopping the plan prevents future renewals only; it does not shorten the current term. Before each renewal, the system sends the person a notice with a single-use stop link. The ending-soon mail to leaders lists only assignments that will actually end. Retention under spec 0007b still applies after renewal stops and the term ends.

## Emergency access

The `Emergency` principal is used only when no Admin can access their account. In that emergency, the IT leader signs in as `Emergency` and restores admin access. It does not count toward the last-active-admin rule; ordinary Admin assignments must still preserve an Active admin.

**Proposed least privilege, pending operator acceptance:** `Emergency` holds only the grants needed to restore admin access: `createAdminGrant`, `reactivateAccount`, `createAccount` for a new admin, reset an admin's sign-in, and `listAuditEntries`. It is not `Admin`, a person, a role assignment, or a term, and it never renews.

Custody belongs to the role `TeamLeader(it)`, not to a named person. At every change of IT leader, the emergency credential is rotated and the handover is recorded. Emergency use is rare and manual. Strong second-factor authentication is always required. Sessions are short and end as soon as the emergency need ends.

There is no self-service recovery for `Emergency`: no password-reset link and no e-mail flow. The credential or second factor is reset or rotated only out of band by whoever holds infrastructure access (database, Cloudflare or Neon), through an audited command-line step. The web app must not offer a recovery path. A party with infrastructure access has already breached the system, so the operator judges that this adds no new attack vector.

Every sign-in and every command by `Emergency` writes an audit row and immediately notifies the admins and the board. The remaining exposure is the second factor and its custody: a lost device or social engineering of the IT leader. Handover rotation is the control.

Open question: who besides the IT leader may hold a sealed backup credential?

## Decisions

One construct covers every decision. A **decision rule** (vedtaksregel) has four parts:

1. **Proposers**: who may propose.
2. **Electorate**: who may vote. It is a set of role kinds in the unit.
3. **Passing rule**: what makes it pass.
4. **Outcome at the deadline**: yes or no, when the passing rule has not decided before the deadline.

| Rule | Proposers | Electorate | Passing rule | At the deadline |
| --- | --- | --- | --- | --- |
| Leader decides | the leader | `{leader}` | one yes | no |
| Leader veto | members | `{leader}` | no objection | yes |
| Vote | members | members | majority, with a quorum | no |

**Leader decides and leader veto are not the same.** Both let one person decide, but they differ when the leader does nothing: under leader decides, nothing happens; under leader veto, the proposal passes. A leader who never answers is the common case, so the choice matters. They are different rules, and one cannot stand in for the other.

The default for teams and for the board is leader decides. That is today's behaviour: the leader adds a member.

A **decision** (vedtak) is a row: the unit, the rule as it was at the proposal, the command and its payload, the proposer, the deadline, and the votes. Its states are a transition table (ADR 0007): `Open`, `Passed`, `Failed`. The rule is stored with the decision, so a later change of the unit's rule does not change an open decision.

- **A passed decision is immutable.** No transition leaves `Passed` or `Failed`, and no command changes a decision's rule, command or payload.
- **The command runs on the authority of the passed decision**, in the same transaction as the transition `Open → Passed`. The decision is the audit record: it names the unit, the rule, the proposer, each vote and the command.
- If the command refuses on a domain guard when it is executed, the decision settles as `Failed` with the refusal recorded; it is not retried as an open decision, and no command writes are committed. An unexpected infrastructure failure rolls back the transaction, so the attempt can be retried.
- A vote that decides at once (leader decides, with the leader as proposer) passes in the transaction that proposes it. A decision that waits for its deadline is settled by a scheduled job, which acts as its own `System` principal (ADR 0008). The deadline is a stored date. Nothing keeps a timer.
- **Changing a unit's rule** is a decision. Its proposers are the unit's leader and an Admin, regardless of the unit's ordinary proposers. It is decided under the unit's current rule, including that rule's electorate, passing rule and deadline outcome.
- The domain package declares which rules each unit kind admits. The first set is the three above.

## Prior art

| Source | What we take from it | Where we differ |
| --- | --- | --- |
| [Fowler, "Accountability"](https://martinfowler.com/apsupp/accountability.pdf) | Party, an organisation hierarchy, and an accountability as an object in its own right, typed at a knowledge level | Our role kinds are the knowledge level, declared in code. The assignment is data. |
| [W3C ORG vocabulary](https://www.w3.org/TR/vocab-org/) | `org:OrganizationalUnit` with `org:subOrganizationOf`, `org:Role`, and `org:Membership` joining a person, a role and an organization | ORG's `org:memberDuring` represents membership time. ORG has no rule for who may assign. |
| [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Permissions as sets of subjects (usersets) over objects, built from relations such as "member of group" | Role assignments are relation tuples. Our closed grant table is like Zanzibar's userset rewrites in configuration: grants are additive and closed. |
| ArchiMate: business actor, business role, assignment, business collaboration ([reference cards](https://www.opengroup.org/sites/default/files/docs/downloads/n221p.pdf), [specification](https://publications.opengroup.org/standards/archimate/specifications/c226)) | An actor is assigned to a role, as a person is assigned to a role kind here. A unit with members that decide together is a collaboration. | ArchiMate describes. It does not decide who may assign. |

The ArchiMate specification pages on `pubs.opengroup.org` ask for a sign-in, so the links above are the reference cards and the catalogue page, which resolve without one (checked 2026-10-27).

**Zachman.** In the [Zachman Framework](https://zachman-feac.com/zachman/about-the-zachman-framework), the **Who** column holds answers to "who" at each row, from stakeholders to the running system. This ADR chooses to keep the Who column traceable across rows: a unit and a role kind appear in the glossary (`GLOSSARY.md`), the system design (`docs/system/`), domain declarations, the generated formal model and the database, all from one declaration (ADR 0009). This is our choice, not a prescription of the Zachman Framework.

## Considered options

- **Keep departments, teams, schools and the admin list as separate entities.** Rejected: each has its own copy of "person in group, with a term, changed by someone". Schools and sponsors would add two more copies.
- **Assigned roles with names an administrator can invent.** Rejected: the same reason as ADR 0001. Authorization would depend on data nobody reviews. Labels give the flexibility without the risk.
- **One decision type per rule (leader decides, leader veto, vote).** Rejected: three state machines and three audit shapes for one idea. Spec 0012 (approvals) would need a fourth.
- **Treat leader veto as a leader-decides decision with the opposite default.** Rejected: that is a different rule under another name. The outcome at the deadline is part of the rule.
- **Make Unit a DDD aggregate or a lock root.** Rejected: Unit is not a lock root. Spec 0006b chooses which existing root guards each write.

## Consequences

- **Kernel.** The subject sets gain `TeamMember` and `TeamLeader`, and `Holder` becomes `Link`. A grant scope `unit` joins `own`, `department` and `all`. Principal facts carry role assignments with their unit, not only team memberships. `authorize` stays one function over the one grant table. The facts type has no field for a label.
- **Decisions in the kernel.** A command declares whether a grant or a decision gives it authority (`authority`, next to `resource` and `method` of ADR 0010). A decision is an entity with a machine, and the decision rules are `Schema` data in the domain package.
- **Renewals.** The kernel declares one mandatory cap per role kind and the approved renewal plan on each assignment. `System(renewals)` runs `extendMembership` on the job's grant, under the Person lock, one interval before the term ends. It rechecks account state, unit state, plan state and cap. A stopped plan or failed check leaves the term to end normally. The job sends the notice and stop link; the ending-soon digest includes only terms that will end.
- **Docgen.** The subject-set table, the grant tables and the system documents show the new names. A new generated block lists the role kinds per unit kind and the decision rules. A command that a decision governs shows "decision of the unit" in its "Granted to" column.
- **effx `DomainDescription`.** A subject set gets a binding to a unit kind and a role kind (the membership binding). Units, role assignments and decisions with their rules need their own entries, so effx needs a spec for them (a follow-up to specs 0031 and 0032). The kernel exports them through the same description (ADR 0009).
- **Formal checks.** The generated model adds:
  - _No escalation._ A person who grants a role on their own authority cannot grant above their own role in that unit. Admin grants are the explicit exception; only Admin grants the root `admin` role. A unit decision gives authority to the unit; whether a vote may assign a role above each voter's own is an open question.
  - _Decision immutability._ No transition leaves `Passed` or `Failed`, and each passed decision ran its command exactly once. A domain refusal settles a decision as `Failed` and records the refusal without committing command writes.
  - _Tree._ No unit is its own ancestor. This holds by construction and the model checks it anyway.
  - _Authority._ Each role assignment has a grant or a passed decision as its origin.
  - _Labels._ No grant, guard or `authorize` input reads a label (a type-level test).
  - _Renewal invariants._ No automatic renewal occurs after the cap, with an inactive account or unit, after the plan is stopped, or for `admin`. A renewal does not need a second decision. The interval and cap come from the role-kind declaration and its granting decision.
- **Specs.**
  - Spec 0009 (applicants): applicant stays a status. Approval into a unit uses the unit's rule.
  - Spec 0011 (placement): a school becomes a unit under its department, and its contacts are role assignments of kind `contact`. Sponsor contacts are also represented as `contact` assignments, but sponsor content remains in EmDash. The scope change needs a brief revision; the spec must declare the contact data's purpose, legal basis and retention before it stores it.
  - Spec 0012 (economy): an approval can reuse a decision, for example "`Fn(economy, d)` decides, one yes".
  - Spec 0006b: a decision's state changes through the conditional transition, so a vote and the deadline job cannot both settle it. `Person` owns role assignments and every automatic renewal takes the Person lock, replacing its ownership of `membership`; the AdminList root lock protocol carries over to `admin` assignments on Vektorprogrammet. The TLA+ membership-writes model follows role assignment, renewal and admin writes. Spec 0006b chooses which existing root guards each write; Unit itself is not a root.
  - Spec 0007/0007b: `System(renewals)` has the job grant for `extendMembership`; account Active is checked for every renewal. Retention still applies after a plan stops and the current term ends.
- **Lost power.** A board member or a leader of one team can no longer add members to other teams. A unit without a leader can only be changed by an Admin. ADR 0002 says that in this case "the board and the admins can still add members": on acceptance that sentence becomes "the admins". The "ending soon" digest then has to reach the admins too.
- **Other ADRs.** On acceptance, ADR 0001 (the admin list is a role assignment), 0002 (explicit renewal plans replace “nothing rolls over by itself” with a capped plan approved by the granting decision), and 0008 (`Holder(p)` is `Link(purpose)` and `Emergency` is a separate principal) each get a revision line. This ADR changes nothing in them until then.
- **Emergency access.** `Emergency` is distinct from `Admin` and does not count toward the last-active-admin invariant. Its proposed least-privilege grant set restores admin access only. Custody follows `TeamLeader(it)` and rotates on handover. Every use is audited and immediately notifies Admins and the board; strong second-factor authentication and short sessions are required. No self-service reset or e-mail flow exists; infrastructure-access holders perform an audited out-of-band CLI reset. Infrastructure access already breaches the system, so this adds no new attack vector. The remaining risk is second-factor custody (lost device or social engineering); handover rotation is the control.

## Migration

The spec that builds this decision writes the migration. It must keep these facts:

- Each department, team, school and sponsor becomes a unit with its parent. Ids stay where they do not collide, so links and audit entries keep working.
- Each membership becomes a role assignment: `leader: true` gives kind `leader`, otherwise `member`. The position becomes the label. The start and end semester become the term. The rule that a person's memberships in one team do not overlap becomes: a person's role assignments in one unit do not overlap.
- Each admin grant becomes an `admin` role assignment on the Vektorprogrammet unit. The rules stay: nobody grants it to themselves, and the last admin with an Active account stays.
- Every unit starts with the rule leader decides. Today's behaviour is unchanged, except for the department-wide grants above.
- The importer (spec 0013) writes the new shape directly. Sponsor content and public sponsor profiles remain in EmDash; only contact relationships enter the core, subject to a personal-data declaration.
- Existing assignments migrate with renewal off. A renewal plan is enabled only by a decision that grants an assignment and approves that plan; imported history does not invent that decision.

## Open questions

1. **Electorate of a vote.** Who is "members" when terms start and end while a decision is open: those at the proposal, or those at each vote? What does the quorum count against? How do abstentions count?
2. **Escalation under a vote.** A vote grants on the authority of the unit, rather than one person's authority. May a vote grant a role above the electors' own?
3. **The admin term.** Today an admin place ends on a date. A role assignment has a term in semesters. Which does `admin` use?
4. **Teams and people.** Who creates, renames or deactivates a team, and who registers a person? They keep today's rows, but a team is a unit and could follow the unit's own rule.
5. **The root leader.** What is `leader` on Vektorprogrammet: the leader of the national board, who is the privacy owner (INFORMATION_MODEL.md §11, decision 11)? Or a role of its own?
6. **Leaderless unit.** Under leader decides, a unit without a leader cannot decide. Should the rule fall back to the unit above, or only to an Admin?
7. **Moving a unit.** Units get a parent once. Moving one needs a check against cycles and a rule for who may do it.
8. **Parent of a sponsor.** Root or department, or both?
9. **Renewal notice.** How many weeks before a planned renewal should the person be notified?
10. **Emergency backup.** Who besides the IT leader may hold a sealed backup credential?

Source: operator decision, 2026-10-27.
