# Teams and people: teams, memberships and the life of a person

> **Status: proposed** (see `README.md`). Phase 4 of the modernization brief.

## What it is for

Volunteers do Vektorprogrammet's work in teams. A membership puts a person in a team for a term of semesters. What a person can do in the system comes from their current memberships and placements. Nobody keeps a separate list of roles.

## Who does what

| You are | You can |
| --- | --- |
| A team leader in the department, or a member of the board | Make and change teams. Add members. Extend, change and end memberships. |
| A member | End your own membership early (resign). |
| A board member or an admin | Do the same as a team leader, also when no team leader in the department has a current membership. |

## Teams and what they can do

Each team has a function. The function decides what its members can do in the system.

| Team (examples) | Function | Members can |
| --- | --- | --- |
| Styret | board | Lead the department; approve expense claims if there is no economy team |
| Økonomi | economy | Approve expense claims and record refunds |
| IT | it | Administration (`administration.md`) |
| Rekruttering | recruitment | Admission and interviews |
| Skolekoordinering | placement | School capacity and placements |
| Sponsor, Profilering, Evaluering, Sosialt | other | Be members; their work happens in Google Workspace or Notion |

## A membership has a term

- A membership starts in one semester and ends in a later one. The end is always set. The default is two semesters, and a team can set one semester instead.
- A membership is active from its start semester to its end semester. The system calculates this. Nobody switches it on or off.
- Nothing continues by itself. Four weeks before the semester ends, each team leader gets a list of memberships that end. Each item has a link to extend it.

## The life of a person

```mermaid
stateDiagram-v2
  [*] --> Prospect : asks for alerts or applies
  Prospect --> Applicant : application sent
  Applicant --> Assistant : placed
  Applicant --> Former : not accepted or withdrawn
  Assistant --> Member : joins a team
  Assistant --> Former : semester ends
  Member --> Member : extended, promoted, moved
  Member --> Former : term ends or resigns
  Former --> Applicant : applies again
  Former --> Member : joins a team again
```

The system calculates this status from the person's engagements. It does not store it.

| Event | What the team leader does | What happens |
| --- | --- | --- |
| Joins a team | Add the member | A membership with the default term. The person gets a welcome e-mail and Google group access. |
| Stays another term | Extend | The same membership gets a later end. Its history stays. |
| Promotion, demotion, change of position or team | Change | The old membership ends, and a new one starts in the chosen semester. History shows both. |
| Leaves on time | Nothing | The term ends. The person loses access and Google group membership. |
| Leaves early | End early | The same, from the chosen semester. |
| Comes back | Add again | A new membership for the same person. |

## When a person leaves

When the last engagement of a person ends, the system sends an e-mail with two separate questions:

1. "Can Vektorprogrammet keep your details for 5 years?" This lets the person come back, and lets Vektorprogrammet write certificates.
2. "Do you want alumni news?"

If the person says no to the first question, or does not answer, the system anonymises their details 1 year after their last engagement. The person can change each answer at any time.

---

## Reference

> **Hand-written** from `INFORMATION_MODEL.md` §9.3, §10.2, §10.3 D, §11.5, §11.9, §11.11. Generated later. Do not add facts that are not in those sources.

### Entities

| Entity | Key fields | Invariants |
| --- | --- | --- |
| Team | `department`, `name`, `function ∈ {board, economy, it, recruitment, placement, other}`, `defaultTerm ∈ {1, 2}` (default 2), `active` | Name unique in the department (RULE-157). A team is deactivated, never deleted (RULE-233). |
| Membership | `person`, `team`, `position`, `leader: boolean`, `start: Semester`, `end: Semester` | `start ≤ end`; the person's memberships in one team do not overlap; the person belongs to the team's department (RULE-164) |
| Person | `name`, `email` (verified), `phone`, `fieldOfStudy`, `gender?`, `companyEmail?` | Company e-mail unique and ends with `@vektorprogrammet.no` (RULE-178, 179) |
| AlumniConsent | `person`, `keepDetails: boolean`, `news: boolean`, text version, given at, withdrawn at |  |

### State machine: Membership

```mermaid
stateDiagram-v2
  [*] --> Planned : addMember (later start)
  [*] --> Active : addMember (start this semester)
  Planned --> Active : start semester reached
  Planned --> [*] : cancel
  Active --> Active : extend(newEnd)
  Active --> Ended : end semester passed
  Active --> Ended : endEarly(semester)
  Ended --> [*]
```

Active, Planned and Ended are calculated from the semester. They replace the legacy suspension flag and job (RULE-219 ✗, 263) and the separate "active" definitions (RULE-016, 023 ✗, 031, 048, 124 ✗).

### Commands and grants

| Command | Granted to | Scope | Replaces |
| --- | --- | --- | --- |
| `createTeam`, `editTeam(function, defaultTerm, …)`, `deactivateTeam` | `Board ∪ Leader(d)` | department | 321, 329 |
| `addMember(person, team, position, leader, start, end = default)` | `Leader(d) ∪ Board` | department | 206, 284 ✗ |
| `extend(newEnd)` | same | department | 234, 251, 252 |
| `change(position \| team \| leader, from)` | same; a move between departments also needs the grant in the receiving department, in one transaction | department | new |
| `endEarly(semester)` | same, or `Self` | department / own | 298 ✗ |
| `cancel` (Planned) | same | department | new |
| `setAlumniConsent(keepDetails, news)` | `Self` | own | new |

### Subject sets (the permission algebra)

| Subject set | Definition |
| --- | --- |
| `Anyone` | Every caller, also without login |
| `Self(r)` | The person that the resource `r` belongs to |
| `Assistant(d)` | Has a Placement in department `d` this semester |
| `Member(d)` | Has an active Membership in a team of `d` |
| `Leader(d)` | Has an active Membership with `leader = true` in a team of `d` |
| `Fn(f, d)` | Has an active Membership in a team of `d` with function `f` |
| `Board` | `Fn(board, *)` |
| `Admin` | On the admin list (`administration.md`) |

A grant is `(subject set, commands, scope)` with scope `own`, `department` or `all`. Grants only add up. There are no deny grants. A command that no grant covers is refused. This model replaces the legacy role ladder, role recalculation and access-rule tables (RULE-029 ✗, 030, 161, 163, 192, 194, 211, 213 ✗, 214, 218 ✗, 275–279, 282, 300–305, 307 ✗).

### Reactions

| Event | Effect | Replaces |
| --- | --- | --- |
| Membership becomes Active | Add to the team's Google group; create a company account on the first membership; welcome e-mail | 243–246, 248, 225 |
| Membership becomes Ended | Remove from the Google group | 242 |
| Four weeks before semester end | "Ending soon" list to each `Leader(d)`, and to `Admin` for admin grants that end | new |
| A person's last engagement ends | Alumni consent e-mail | new |

### Personal data

| Data | Purpose | Legal basis | Retention |
| --- | --- | --- | --- |
| Person (name, e-mail, phone, field of study) | Run engagements | Art. 6(1)(b)/(f) | 1 year after the last engagement, or 5 years with `keepDetails` |
| Gender (optional) | Totals only | Art. 6(1)(f) | With the person |
| Membership history | Certificates, history | Art. 6(1)(f) | 10 years |
| Alumni news | News e-mail | Art. 6(1)(a) | Until withdrawn |
| Photo | Not collected; with consent only for a public team page | Art. 6(1)(a) | Until withdrawn, or the engagement ends |
