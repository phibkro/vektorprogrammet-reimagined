---
status: proposed
---

# Elections: electorate, typed voting systems and the secret ballot

Today a department elects its leaders by show of hands at a physical meeting. The voters are the members who have voting rights. The goal is an election for every leader, board member and other privileged position, once per semester or once per year, run in the system.

An **election** is a kind of democratic decision (ADR 0011). An **election type** is declared in code, because it decides who votes and which role the winner gets, and privileges are static (ADR 0001, ADR 0011). An **election** instance is a run-time session. A **voting system** is one typed declaration that says how ballots become a result. The bylaws (vedtekter) are not available yet. Every value that depends on them is one declaration, marked **assumed** or **open** (see Values that depend on the bylaws). An election is one **Activity type**. An Activity is planned by people, run on a schedule by the system and notifies its participants through the outbox (mail or Slack). It may have optional capabilities: RSVP, check-in (attendance for quorum), and voting. An election has the Voting capability; meeting mode also has Check-in, and RSVP is optional. The Activity's audience follows the subtree electorate rule below. An Activity is not a domain or audit event: commands record those events as they run. ADR 0013, “Activities,” will define the Activity frame. Its shape is open here; this ADR defines only elections and their voting capability.

## Decisions have kinds

```text
Decision
├─ Authority decision   leader decides · leader veto
└─ Democratic decision
   ├─ Motion vote       yes/no on a proposal
   └─ Election          candidates for seats, counted by a voting system
```

A kind is a construct in code. A type is a declaration in code. An instance is data.

| Level | Decision | Election | Voting system |
| --- | --- | --- | --- |
| Kind | Authority decision, Democratic decision | Election | `VotingSystem`, a typed composition |
| Type | Leader decides, leader veto, motion vote | Team leader election, Department board election, National board election | A preset: plurality, majority with runoff, IRV, STV, approval, and others |
| Instance | One decision | The Trondheim board election, spring 2027 | One count |

ADR 0011 has three decision rules. **Leader decides** and **leader veto** are authority decisions. Its **vote** rule is the motion vote. An election is not a fourth row of that table: its electorate is a subtree of units, and its outcome is a set of persons, not yes or no.

## Electorate

One rule decides the electorate of every election type:

> The electorate is every person with a current team membership in the subtree of the position's unit, frozen at the nomination cut-off.

"Team membership" means a current role assignment of kind `member` or `leader` in a unit of kind Team (ADR 0011). The **scope unit** of a position is the unit that the position leads: a team leads itself, a department board leads its department, and the national board leads Vektorprogrammet.

| Election type | Position | Scope unit | Who votes |
| --- | --- | --- | --- |
| Team leader election | `leader` of team `t` | `t` | The members of `t` |
| Department board election | Seats of the board of department `d` | `d` | The members of every team in `d` |
| National board election | Seats of the national board | Vektorprogrammet | The members of every team in every department (for example Trondheim, Tromsø, Ås and Bergen), and of the teams directly under the root |

- A person counts once, however many teams the person is in.
- **Never** assistants (they have a placement, not a team membership), and never contacts of a School or Sponsor (external units).
- **Frozen at the nomination cut-off.** The system writes the electorate as rows when nominations close. A person who joins a team later cannot vote. A person who leaves later still can. Nothing else changes the rows.
- **The national board is new.** Today only department boards exist (`docs/system/teams.md` gives every team a department). The national board is a team directly under the Vektorprogrammet root. This is operator input (2026-10-27); ADR 0011 already lists the national board as a Team under the root.

This resolves question 1 of ADR 0011 (who is "members" when terms start and end while a decision is open) for elections: the electorate is the one frozen at the cut-off. For a motion vote, this ADR proposes the same: the electorate is frozen when the motion is proposed. Quorum and abstentions for a motion vote depend on the bylaws.

## Choices per election instance

Each instance fixes these at announcement. None changes after voting starts.

- **Ballot: secret or open.** Both are available. A secret ballot keeps no link from a voter to a choice. An open ballot records who voted for what, like a show of hands.
- **Mode: meeting, remote, or both.**
  - _Meeting_: members check in (the check-ins count toward the quorum) and vote on their phones in the room. The chair opens and closes each round.
  - _Remote_: voting is open in a window that has a start and an end. A scheduled job closes it.
  - _Both_: a person votes in either way, once per round.

## Lifecycle

An election is a machine with a transition table (ADR 0007). A passed or failed decision never goes back; here, no state goes back, except the runoff, which opens a new voting round.

| From | Command | To | Notes |
| --- | --- | --- | --- |
| `[*]` | `createElection` | Announced | Type, unit, positions, seats, ballot kind, mode, dates, certifiers. A type with an open value refuses. |
| Announced | `openNominations` | Nominations | At the announced date. |
| Nominations | `startVoting` | Voting | The cut-off. Writes the electorate rows. Needs more candidates than seats for a contested count. |
| Voting | `closeVoting` | Counting | The chair, or the job at the end of the window. Refuses when the quorum is not met. |
| Counting | `countElection` (job) | Voting | The count says **runoff**: a new round among the tied or remaining candidates, same electorate. |
| Counting | `countElection`, `settleTie` | Counting | A tie that the declared tie-break gives to the committee or to a lot waits for that step. |
| Counting | `certifyElection` | Certified | A decision of the certifiers. Writes the result. No command changes it afterwards. |
| Certified | `seatElected` (job) | Seated | At the term start. `System(elections)` creates the role assignments. |

- **Certification** is an authority decision (ADR 0011). Its certifiers are the election committee or the meeting chair, whichever the bylaws say. A passed certification is the decision that grants the roles. It is the origin of each role assignment.
- `System(elections)` is its own principal (ADR 0008). Its grants are the job steps above: open nominations, start voting, close a remote window, count, seat. It cannot certify.
- **Elected roles do not renew automatically.** An election type declares no renewal plan, and a certification approves none. This overrides the renewal defaults of ADR 0011 for elected roles. When the term ends, the role assignment ends. What happens until a successor is seated (holdover) is an open question.
- **Races by construction.** Each transition is a conditional `UPDATE … WHERE state = from`. A person casts at most one ballot per round because the participation row has a unique key. A ballot cannot arrive after the close: casting and closing conflict on the election row. Spec 0006b decides the exact lock protocol.

## The voting system

A **voting system** composes a ballot type, compatible aggregation, compatible win condition, denominator and tie-break chain. Seats and quorum are separate parameters. Threshold and denominator have declared defaults and may vary within the options allowed by the election type:

```text
VotingSystem = BallotType × Aggregation(BallotType) × WinCondition(Aggregation) × Denominator × TieBreakChain
```

Each part is typed by the one before it. The declaration is a union of the valid tuples, not a product that a check rejects, so an invalid combination (the median of single choices, IRV over approval ballots) cannot be written.

**Ballot type.** What one ballot holds.

| Ballot type    | A ballot holds                                              |
| -------------- | ----------------------------------------------------------- |
| Yes/no/abstain | One of the three (a motion)                                 |
| Single choice  | One candidate, or blank                                     |
| Approval       | A set of candidates                                         |
| Ranked         | A priority list of candidates                               |
| Score or grade | A number or a grade for each candidate, on a declared scale |

**Aggregation.** How ballots become one result. Each ballot type has its own set.

| Ballot type | Aggregation | Result |
| --- | --- | --- |
| Yes/no/abstain | Count | Tally of yes, no, abstain |
| Single choice | Count | Tally per candidate |
| Approval | Count (sum of approvals) | Tally per candidate |
| Ranked | Elimination rounds (IRV, STV) | Round trace and elected set |
| Ranked | Borda sum | Points per candidate |
| Ranked | Pairwise matrix (Condorcet, Schulze) | Matrix of pairwise counts |
| Score or grade | Sum, mean | Tally per candidate |
| Score or grade | Median (grades) | Median grade per candidate |

**Win condition.** What makes a candidate or a motion win. Each result has its own set.

| Result | Win conditions |
| --- | --- |
| Tally of a motion | Threshold: more than half, or two thirds, of the denominator |
| Tally per candidate | Plurality; majority (more than half of the denominator), with a runoff; the highest sum or mean |
| Round trace | A majority of the continuing ballots (IRV); quota, Droop (STV) |
| Matrix of pairwise counts | Condorcet winner; Schulze winner |
| Median grade per candidate | The highest median grade (majority judgment) |

A win condition that uses a threshold also declares its **denominator**: the valid ballots, all ballots (blank ones too), or the whole electorate. A win condition without a threshold has no denominator field. The **quorum** is declared beside the win condition: the share of the frozen electorate that must be present (meeting) or must have voted (remote).

**Tie-break.** What happens when the win condition does not give a winner. It is an ordered chain of **runoff** (a new voting round), **seniority**, **committee** (the certifiers decide) and **lot** (a recorded random draw). The last link must be the committee or a lot, because those two always give a result. A runoff cap is part of the chain. A motion vote has no tie-break: a tie does not reach the threshold, so the motion does not pass (the deadline outcome of ADR 0011).

**Presets.** A named voting system is a declared tuple. The bylaws pick one preset per position of an election type; until they arrive, the choice is an assumption.

| Preset | Ballot | Aggregation | Win condition | Seats |
| --- | --- | --- | --- | --- |
| Plurality | Single choice | Count | Plurality | 1 |
| Majority with runoff | Single choice | Count | Majority, then a runoff | 1 |
| Instant runoff (IRV) | Ranked | Elimination rounds | Majority of the continuing ballots | 1 |
| Single transferable vote (STV) | Ranked | Elimination rounds | Droop quota | 1 or more |
| Approval | Approval | Count | Highest sum | 1 or more |
| Score | Score | Sum or mean | Highest sum or mean | 1 or more |
| Majority judgment | Grade | Median | Highest median grade | 1 |
| Schulze | Ranked | Pairwise matrix | Schulze winner | 1 |
| Motion | Yes/no/abstain | Count | Threshold | n/a |

**No system meets every fairness criterion.** Arrow's theorem (1951) shows that no ranked system for three or more candidates is at once unanimous, free of a dictator and independent of irrelevant alternatives. The Gibbard–Satterthwaite theorem (Gibbard 1973, Satterthwaite 1975) shows that every deterministic ranked system for three or more candidates, where any candidate can win, is dictatorial or open to tactical voting. Score and approval ballots lie outside Arrow's frame, because they carry more than a ranking. They still allow tactical voting. So each preset declares the criteria it meets and the criteria it fails. The choice of preset is a choice of which failures the organisation accepts.

| Preset | Majority | Condorcet | Monotonicity | IIA |
| --- | --- | --- | --- | --- |
| Plurality | meets | fails | meets | fails |
| Majority with runoff | meets | fails | fails | fails |
| IRV | meets | fails | fails | fails |
| STV (Droop quota) | meets for one seat; meets Droop proportionality | fails | fails | fails |
| Approval | fails | fails | meets | meets |
| Score | fails | fails | meets | meets |
| Majority judgment | fails | fails | meets | meets |
| Schulze | meets | meets | meets | fails |

- _Majority_: a candidate that most voters rank first wins. _Condorcet_: a candidate that beats every other candidate in pairwise counts wins. _Monotonicity_: more support for a winner never makes the winner lose. _IIA_: adding or removing a losing candidate does not change who wins among the rest.
- For approval, score and grade ballots, the criteria apply to a derived ranking, and IIA holds when each voter's marks for the other candidates do not change.
- This table is the textbook classification. The tests are the authority: a mismatch is a bug in the table, not in the tests.
- **How it is checked.** Property-based tests check each criterion that a preset meets. Each criterion that a preset fails has a recorded counterexample, a small set of ballots that shows the failure, so the table cannot claim more than the code does. Alloy models (ADR 0009) check the same criteria in a small scope: a few candidates and a few voters.

**Counting is a pure function.** It takes the ballots, the candidates, the seats and the preset, and returns the result and its trace: `Elected`, `Runoff`, or a tie that the chain gives to the committee or to a lot. The lot is a separate recorded step; the count itself never uses randomness. A voting system also makes the ballot's `Schema`, and the server and the client use the same function, as they do for interview forms (ADR 0003).

**Motion votes reuse the composition.** A motion vote is the `Motion` preset: a yes/no/abstain ballot, a count, a threshold with its denominator, and a quorum.

## The secret ballot

Two records stay apart:

| Record | Holds | Does not hold |
| --- | --- | --- |
| Participation | Election, round, person (unique per round): who has voted | The choice, and any exact time |
| Secret ballot | Random id, election, round, choice | A person, a participation key, a time, a running number |
| Open vote | Election, round, person, choice | (Used only when the instance is open) |

- **Casting** (a secret instance) checks the state and the round, inserts the participation row (a second ballot in the round fails on the unique key), and inserts the secret ballot. A secret instance never writes an open vote.
- **Counting** reads the ballots in shuffled order. When voting closes, the job writes the ballots again in one new transaction, in random order, and deletes the first copies. The stored ballots then carry no order of arrival and one shared transaction id.
- **No tally** is readable before voting closes, for either kind.
- The payload of a ballot never enters the audit log or any application log. This follows the audit rule that the log keeps no changed values (`docs/system/administration.md`). No command reads a secret ballot, except the count.
- **Unlinkability is a schema property.** No column of the secret-ballot table references a person or a participation row, and the table has no time column and no running number. A generated schema check fails when one appears.
- **An open ballot** records the voter and the choice. It is the same as a show of hands, with a record.

**Residual trust in the operators.** A person with database or platform access during voting can link ballots to voters. The links that the design removes from the data model remain in the database engine and the platform: transaction ids, the physical order of rows, the write-ahead log, backups and history of the managed database, and request logs and timing. [INFERENCE: not tested here.] An operator can also change the code that counts. No voter can check that their own ballot was counted. The people with that access are those who already hold the system's infrastructure, including the custody of `Emergency` (ADR 0011), and ADR 0011 already judges that infrastructure access is a breach of the system. In meeting mode, a person who looks at a phone screen sees a vote, and a remote voter can be pressed to vote in a certain way. The design does nothing against that.

## Personal data

Each field below is declared in `packages/domain` with its purpose, legal basis and retention (ADR 0004). This table is the proposal for that declaration. The legal basis is for the privacy owner to confirm.

| Data | Purpose | Kept for |
| --- | --- | --- |
| Electorate rows, check-ins, participation | Check who may vote and who has voted; the quorum | Until the appeal window ends, then deleted |
| Secret ballots and open votes | Count the ballots; a recount in the appeal window | Until the appeal window ends, then deleted |
| Candidacy of a person who is not elected | Show the candidates; count their ballots | Until the appeal window ends, then deleted |
| Result: the elected persons, the certification decision | Record who holds a position and why | With the role assignment history (10 years) |
| Turnout and the size of the electorate | Show that the election was valid | Counts, not personal data; not deleted |

The appeal window is a bylaws value. An election type cannot be announced without it.

## Formal properties

The generated models (ADR 0009: Alloy 6 first, TLA+ for the lifecycle when enabled) check these. Each is stated as a property of the declarations, not of a hand-written model.

1. **One counted ballot per eligible voter, per round.** The participation key is unique, and the number of ballots in a round equals the number of participation rows when voting closes.
2. **No ballot from outside the electorate.** Every participation row has a matching electorate row. The electorate rows do not change after the cut-off.
3. **The result is the voting system applied to the ballots.** A recount in the appeal window gives the same result.
4. **A certified result cannot change.** No transition leaves Certified except to Seated, and no command writes the result again.
5. **Unlinkability.** No column of a secret ballot links it to a voter (see the secret ballot).
6. **The preset criteria hold or fail as declared** (see the voting system).
7. **Authority.** Each elected role assignment has a passed certification as its origin (ADR 0011).

## Values that depend on the bylaws

The bylaws (vedtekter) are not available. All values below are in one declaration in `packages/domain`. Each has a status. An **assumed** value is used, and every document that shows it shows the marker. An **open** value has no value: the command that needs it refuses and names it. Tests and docs read the declaration, never a literal. When the bylaws arrive, one declaration changes and the status says which paragraph the value comes from.

| Value | Status | Value now |
| --- | --- | --- |
| Quorum, and what it counts | open | none |
| Who may stand, and how | assumed | An elector nominates, or a person nominates themselves; the candidate accepts |
| Voting system, per position | assumed | Team leader: majority with runoff. Board: `leader` by majority with runoff, then `member` seats by STV |
| Seats of a board, and their bounds | open | none |
| Term length | assumed | Two semesters (one year) for each type; one semester is allowed by the declaration |
| Holdover until a successor is seated | open | none |
| Election committee, or the chair | open | none |
| Denominator of a threshold | assumed | Valid ballots |
| Tie-break chain and runoff cap | assumed | One runoff, then committee, then lot |
| Appeal window | open | none |
| Who may announce an election | assumed | The leader of the unit, or an Admin |
| Notice and nomination periods | open | none |
| Whether a secret ballot is required | open | none; the instance chooses |

## Prior art

| Source | What we take from it | Where we differ |
| --- | --- | --- |
| [Helios](https://heliosvoting.org/) | End-to-end verifiable online elections: private ballots, and a tracking number that each voter can check | Considered, not chosen (see Considered options) |
| [Arrow's impossibility theorem](https://en.wikipedia.org/wiki/Arrow%27s_impossibility_theorem) | No ranked system meets every fairness criterion | We state the failures of each preset, and test them |
| [Gibbard–Satterthwaite theorem](https://en.wikipedia.org/wiki/Gibbard%E2%80%93Satterthwaite_theorem) | Deterministic ranked systems allow tactical voting | We do not claim a manipulation-proof system |

## Considered options

- **End-to-end verifiable voting (Helios).** A voter could check that the ballot was counted, and the operators would not have to be trusted with the count. Not chosen. It adds trustee keys, encryption in the browser and a second system to run. This ADR states the residual trust of the plain design instead. The operator can revisit the choice if that trust is not enough.
- **Name each voting system as one counting function.** Rejected: nothing then says which ballots a function accepts, and invalid pairs (the median of single choices) could be declared. The typed composition makes them unwritable and gives each criterion one place to be checked.
- **One electorate per election type, written by hand.** Rejected: one rule over the unit tree covers all three types and any later one.
- **Create the role assignment at certification, with a future start.** Not chosen: the operator chose that `System(elections)` creates it at the term start.
- **Only open ballots, like today.** Rejected: a secret ballot must be possible for elections of persons.

## Extensible voting systems: presets and composition

The parts of a voting system are **building blocks in code**: ballot types, compatible aggregations, compatible win conditions, denominator choices, and tie-break rules. Tests and small-scope Alloy models verify each building block and its composition. Extending the system means adding a building block in code; election instances do not invent new code.

An election instance chooses and stores its voting system as data from the options its election type permits. The system is frozen when nominations open, before the candidate list is known. It cannot be changed after that point. An election type may allow a choice among presets and parameter ranges, or fix one method (as the bylaws may require for the national board).

There are two ways to configure it:

- **Preset (porcelain):** choose a named composition with sensible defaults for its parameters.
- **Composition (plumbing):** choose each compatible part and its parameters. Types make meaningless combinations unrepresentable.

The threshold and denominator are variables with defaults, not fixed system rules. A preset can default to one half, two thirds, or another fraction. A denominator can be valid ballots (default), all ballots cast including blank ballots, checked-in attendees, or the whole electorate. The instance may choose from the values its type permits. A tie-break chain tries its ordered rules until one decides; its default ends in lot, which always decides.

Motion votes use the same composition: yes/no/abstain ballot, count aggregation, a threshold (for example one half or two thirds), denominator and quorum.

The table of presets above shows examples, not an exhaustive closed set. Each preset is a precomposed tuple. Its parts are extensible in code. A preset is available to an election only if its election type permits it.

- **Domain.** Election types, positions, voting-system presets, the criteria table and the bylaws values are `Schema` data in `packages/domain`. Runtime, UI, docs and tests read them.
- **Kernel.** A new subject set `Elector(e)`: the principal has a row in the frozen electorate of election `e`. The election comes from the command's resource, as the team does for `TeamMember(t)`. A command declares whether a grant or a decision gives it authority (ADR 0011). `certifyElection` is a decision. A passed decision's command runs in the same transaction (ADR 0011); here the decision's command is the certification, and `seatElected` is a later command of `System(elections)` with that decision as its origin.
- **Machines and jobs.** The election machine and its transition table. `System(elections)` has its own grants and runs the steps marked "job". A retention job deletes the ballot data when the appeal window ends.
- **Docgen.** Generated blocks list the election types, the voting-system presets with their criteria, and the bylaws values with their status. A value that is assumed or open is marked wherever it is shown.
- **Other decisions.** On acceptance, ADR 0011 gets revision lines: its vote rule is the motion vote; question 1 is resolved for elections; elected roles do not take the renewal defaults; a decision may authorise a later command of a job. The Team entity of spec 0006 requires a department; the national board team under the root follows the unit tree of ADR 0011.
- **The `Board` subject set.** `Fn(board, *)` means "a board of some department". The grants of the national board (for example the privacy owner, `docs/system/administration.md`) are an open question.

## Open questions

1. **Holdover.** Does the outgoing leader stay in the role until a successor is seated? Without it, a unit with no seated leader has no leader, and ADR 0011 question 6 applies.
2. **Vacancy.** A leader or board member resigns during a term. Is there a by-election? May an Admin put a person in an elected role directly (ADR 0011 allows it)?
3. **Failed elections.** No candidates, no more candidates than seats, or the quorum is not met. The lifecycle has no failing state. Proposal: a `Void` state that needs a new announcement.
4. **Appeals.** A certified result cannot change. What does an upheld appeal do? Proposal: a decision of the certifiers voids the election, and a new election follows.
5. **Electors without an Active account.** A member with no way to sign in is in the frozen electorate. May the chair record a vote for them?
6. **Conflicts of interest.** May a candidate chair the meeting or sit on the election committee?
7. **Visibility.** Who may read open votes, and when? Proposal: the certifiers and the electorate, after the count. Are the tallies of each round kept after the ballots are deleted? They are not personal data about a voter, but they show a candidate's support.
8. **The root teams.** By the electorate rule, the members of teams directly under the root, among them the national board itself, vote in the national board election. Does the operator confirm that?
9. **Labels of board seats.** Are "nestleder" and "kasserer" voted for as positions, or does the elected board set the labels after seating? Labels never give a permission (ADR 0011), so both work.
10. **Several positions.** May a person stand for the leader and a member seat at once? Assumption: positions are counted in order, and an elected person leaves the later counts.
11. **Which units elect.** Does every team elect its leader, or only some teams? The election type applies to a unit, and the bylaws decide which units use it.
12. **Presence in a meeting.** How does the system know that a person who checks in is in the room: the chair confirms, or a code on the screen in the room?

Source: operator decisions, 2026-10-27. The national board as a team under the root is operator input, 2026-10-27.
