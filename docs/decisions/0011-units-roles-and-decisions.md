---
status: proposed
---

# Units, role assignments and decisions

The organisation is a tree of **units**. A **role assignment** puts a person in a role kind in one unit for a term. A **decision rule** says how a unit decides, and a passed **decision** is the authority for a command and the audit record of it. Role kinds and decision rules are declared in code. Labels and decisions are data. Only role kinds and passed decisions grant anything.

The accepted design has departments, teams, schools and sponsors as separate things, a membership that joins a person to a team, and an admin list beside it. They have the same shape: a group of persons, a person's place in it, and a rule for who may change that. Leader permissions are department-wide today (`Leader(d) ∪ Board`), so a leader of one team can add members to every team of the department. Nothing records how a team decides, and "leader decides" is only a habit.

Source of all decisions below: operator, 2026-10-27.

## Units

A **unit** (enhet) is an organisational grouping of persons: Vektorprogrammet, a department, a team, the board, a school, a sponsor.

- Units form a tree. Each unit except the root has one parent. Vektorprogrammet is the root.
- A unit gets its parent when it is created, and the parent must already exist. So a cycle cannot be written. Each unit kind declares the kinds that it may sit under.
- The kinds are `Vektorprogrammet`, `Department`, `Team`, `School` and `Sponsor`. The board is a team whose function is `board` (ADR 0001). School and Sponsor are external units: their people are not Vektorprogrammet's own.
- A unit is not a DDD aggregate. Which units are lock roots stays a separate decision (spec 0006b).

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

A **role assignment** is a person, a role kind, a unit and a term (ADR 0002). It generalises the membership. The admin list becomes the `admin` role on the Vektorprogrammet unit. Each role kind has a place in a partial order inside its unit kind (`leader` is above `member`), which the no-escalation check uses.

**Member of Vektorprogrammet** is not stored. It is true while a person has a current engagement (a placement or a role assignment in a unit below the root). The `member` role kind on the root exists so that a grant can name it; nobody assigns it.

## Subject sets

The subject sets of ADR 0001 follow from role assignments. Sets of one team take the team from the command's resource.

| Subject set | Meaning | Replaces |
| --- | --- | --- |
| `TeamMember(t)` | A current role assignment of kind `member` or `leader` in team `t` | `Member(d)`, narrowed to one team |
| `TeamLeader(t)` | A current role assignment of kind `leader` in team `t` | `Leader(d)`, narrowed to one team |
| `Member(d)`, `Leader(d)` | Derived: `TeamMember(t)` or `TeamLeader(t)` for some team `t` in department `d` | stay, with this definition |
| `Fn(f, d)`, `Board` | Unchanged |  |
| `Admin` | A current `admin` role assignment on the Vektorprogrammet unit | the admin list |
| `Link(purpose)` | A credential for one purpose that any status can present, restricted to its command and person. It is not a role. | `Holder(p)` |
| `Self`, `Anyone`, `System(job)` | Unchanged |  |

**Applicant** is a lifecycle status (spec 0009), not a role. Roles can overlap, and each step from applicant towards a role in a unit needs an approval.

## Who grants a role

Only a unit itself, by its decision, or an Admin can put a person into that unit. The same holds for the board. A leader of team `a` has no power over team `b`.

"Leader status in team `t`" is `TeamLeader(t) ∪ Admin`. This replaces the department-wide `Leader(d) ∪ Board` grants on memberships (legacy RULE-206 and RULE-284 put those grants in one place: any leader of the department). The rows that change:

| Command | Today | Proposed |
| --- | --- | --- |
| `createMembership`, `extendMembership` (team `t`) | `Leader(d) ∪ Board`; `Admin` | a decision of `t` (default: `TeamLeader(t)` decides); `Admin` |
| `changeMembership` (from `t1` to `t2`) | `Leader(d) ∪ Board`; `Admin`, and the grant in the receiving department | `TeamLeader(t1) ∪ Admin` for the end, and a decision of `t2` or `Admin` for the start, in one transaction |
| `endEarlyMembership` | `Leader(d) ∪ Board`; `Self`; `Admin` | `TeamLeader(t)`; `Self`; `Admin` |
| `deleteMembership` (not started) | `Leader(d) ∪ Board`; `Admin` | `TeamLeader(t)`; `Admin` |

Other grants that use `Leader(d)` or `Board` (create, update and deactivate a team, register a person, see people, accounts, admission, placement) keep their rows. Whether they become unit-bound is open (see Open questions).

An Admin acts on the authority of the `Admin` grant. The audit entry names that grant, not a decision.

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
- A vote that decides at once (leader decides, with the leader as proposer) passes in the transaction that proposes it. A decision that waits for its deadline is settled by a scheduled job, which acts as its own `System` principal (ADR 0008). The deadline is a stored date. Nothing keeps a timer.
- **Changing a unit's rule** is a decision. The leader of the unit or an Admin proposes it. It is decided under the unit's current rule, so an Admin cannot force a change on a unit whose leader says no.
- The domain package declares which rules each unit kind admits. The first set is the three above.

## Prior art

| Source | What we take from it | Where we differ |
| --- | --- | --- |
| [Fowler, "Accountability"](https://martinfowler.com/apsupp/accountability.pdf) | Party, an organisation hierarchy, and an accountability as an object in its own right, typed at a knowledge level | Our role kinds are the knowledge level, declared in code. The assignment is data. |
| [W3C ORG vocabulary](https://www.w3.org/TR/vocab-org/) | `org:OrganizationalUnit` with `org:subOrganizationOf`, `org:Role`, and `org:Membership` joining a person, a role and an organization | ORG has no term and no rule for who may assign. We add both. |
| [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Permissions as sets of subjects (usersets) over objects, built from relations such as "member of group" | We keep the sets in a closed, typed table in code. We do not store tuples that grant. |
| ArchiMate: business actor, business role, assignment, business collaboration ([reference cards](https://www.opengroup.org/sites/default/files/docs/downloads/n221p.pdf), [specification](https://publications.opengroup.org/standards/archimate/specifications/c226)) | An actor is assigned to a role, as a person is assigned to a role kind here. A unit with members that decide together is a collaboration. | ArchiMate describes. It does not decide who may assign. |

The ArchiMate specification pages on `pubs.opengroup.org` ask for a sign-in, so the links above are the reference cards and the catalogue page, which resolve without one (checked 2026-10-27).

**Zachman.** In the [Zachman Framework](https://zachman-feac.com/zachman/about-the-zachman-framework), the **Who** column holds the answers to "who" at every row, from the stakeholders (the organisation chart) to the running system (identities and rights). The framework asks that the cells of one column stay traceable across rows. This decision keeps that: a unit and a role kind are in the glossary (`GLOSSARY.md`), in the accepted system design (`docs/system/`), in the domain declarations, in the generated formal model and in the database, all from one declaration (ADR 0009). The Who column then has one source, and a change shows in every row.

## Considered options

- **Keep departments, teams, schools and the admin list as separate entities.** Rejected: each has its own copy of "person in group, with a term, changed by someone". Schools and sponsors will need contacts and would add two more copies.
- **Assigned roles with names an administrator can invent.** Rejected: the same reason as ADR 0001. Authorization would depend on data nobody reviews. Labels give the flexibility without the risk.
- **One decision type per rule (leader decides, leader veto, vote).** Rejected: three state machines and three audit shapes for one idea. Spec 0012 (approvals) would need a fourth.
- **Treat leader veto as a leader-decides decision with the opposite default.** Rejected: that is a different rule under another name. The outcome at the deadline is part of the rule.
- **Make Unit an aggregate with a lock.** Not decided here: spec 0006b owns lock roots.

## Consequences

- **Kernel.** The subject sets gain `TeamMember` and `TeamLeader`, and `Holder` becomes `Link`. A grant scope `unit` joins `own`, `department` and `all`. Principal facts carry role assignments with their unit, not only team memberships. `authorize` stays one function over the one grant table. The facts type has no field for a label.
- **Decisions in the kernel.** A command declares whether a grant or a decision gives it authority (`authority`, next to `resource` and `method` of ADR 0010). A decision is an entity with a machine, and the decision rules are `Schema` data in the domain package.
- **Docgen.** The subject-set table, the grant tables and the system documents show the new names. A new generated block lists the role kinds per unit kind and the decision rules. A command that a decision governs shows "decision of the unit" in its "Granted to" column.
- **effx `DomainDescription`.** A subject set gets a binding to a unit kind and a role kind (the membership binding). Units, role assignments and decisions with their rules need their own entries, so effx needs a spec for them (a follow-up to specs 0031 and 0032). The kernel exports them through the same description (ADR 0009).
- **Formal checks.** The generated model adds:
  - _No escalation._ When a person grants a role by their own authority (leader decides, Admin), the granter's role in that unit is not below the granted role. A role assignment cannot raise a person above the granter.
  - _Decision immutability._ No transition leaves `Passed` or `Failed`, and each passed decision ran its command exactly once.
  - _Tree._ No unit is its own ancestor. This holds by construction and the model checks it anyway.
  - _Authority._ Each role assignment has a grant or a passed decision as its origin.
  - _Labels._ No grant, guard or `authorize` input reads a label (a type-level test).
- **Specs.**
  - Spec 0009 (applicants): applicant stays a status. Approval into a unit uses the unit's rule.
  - Spec 0011 (placement): a school becomes a unit under its department, and its contacts are role assignments of kind `contact`. A sponsor is the same.
  - Spec 0012 (economy): an approval can reuse a decision, for example "`Fn(economy, d)` decides, one yes".
  - Spec 0006b: the decision's state changes through the conditional transition, so a vote and the deadline job cannot both settle it. Whether a decision is a lock root is decided there.
- **Lost power.** A board member or a leader of one team can no longer add members to other teams. A unit without a leader can only be changed by an Admin. ADR 0002 says that in this case "the board and the admins can still add members": on acceptance that sentence becomes "the admins". The "ending soon" digest then has to reach the admins too.
- **Other ADRs.** On acceptance, ADR 0001 (the admin list is a role assignment), 0002 (above) and 0008 (`Holder(p)` is `Link(purpose)`) each get a revision line. This ADR changes nothing in them until then.

## Migration

The spec that builds this decision writes the migration. It must keep these facts:

- Each department, team, school and sponsor becomes a unit with its parent. Ids stay where they do not collide, so links and audit entries keep working.
- Each membership becomes a role assignment: `leader: true` gives kind `leader`, otherwise `member`. The position becomes the label. The start and end semester become the term. The rule that a person's memberships in one team do not overlap becomes: a person's role assignments in one unit do not overlap.
- Each admin grant becomes an `admin` role assignment on the Vektorprogrammet unit. The rules stay: nobody grants it to themselves, and the last admin with an Active account stays.
- Every unit starts with the rule leader decides. Today's behaviour is unchanged, except for the department-wide grants above.
- The importer (spec 0013) writes the new shape directly.

## Open questions

1. **Electorate of a vote.** Who is "members" when terms start and end while a decision is open: those at the proposal, or those at each vote? What does the quorum count against? How do abstentions count?
2. **Escalation under a vote.** The no-escalation check covers a role that one person grants. A vote grants on the authority of the unit, so members could vote a leader in. May a vote grant a role above the electors' own?
3. **The admin term.** Today an admin place ends on a date. A role assignment has a term in semesters. Which does `admin` use?
4. **Teams and people.** Who creates, renames or deactivates a team, and who registers a person? They keep today's rows, but a team is a unit and could follow the unit's own rule.
5. **The root leader.** What is `leader` on Vektorprogrammet: the leader of the national board, who is the privacy owner (brief § 11)? Or a role of its own?
6. **Leaderless unit.** Under leader decides, a unit without a leader cannot decide. Should the rule fall back to the unit above, or only to an Admin?
7. **Moving a unit.** Units get a parent once. Moving one needs a check against cycles and a rule for who may do it.
8. **Admin and the rule.** An Admin can add a member to a unit that votes, but cannot change its rule alone. Is that the intended asymmetry?
9. **Parent of a sponsor.** Root or department, or both?
