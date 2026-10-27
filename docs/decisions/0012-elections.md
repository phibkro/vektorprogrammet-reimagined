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

> The electorate is the people with current `member`/`leader` assignments in **Team** units in the subtree of the scope unit, frozen at nomination cut-off.

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

- **Ballot: secret or open.** Both are available. A secret ballot has no voter-choice link in the election database; in SlackDM the Slack processor receives the user's identity and choice together (see Residual trust). An open ballot records who voted for what, like a show of hands.
- **Mode: meeting, remote, or both.**
  - _Meeting_: only a person in the frozen `Elector(e)` may check in; check-in and attendance quorum count that set, then the person votes on a phone in the room. The chair opens and closes each round. This election-specific check-in is not ADR 0013's live `Audience(a)` check-in.
  - _Remote_: voting is open in a window that has a start and an end. A scheduled job closes it.
  - _Both_: the person must be in `Elector(e)` and can vote in either way, once per round.
- **Ballot channel: `SlackDM` or `Web`.** Each instance sets one channel. The channel is fixed at announcement and cannot be changed. ADR 0013 owns the Activity delivery frame; this ADR owns the election's ballot channel and its secrecy properties.

## Lifecycle

The Activity lifecycle owns planning, announcement and participant notices; the election machine owns nominations, ballots, counting, certification and seating. createElection creates a Planned Activity. announceElection also runs announceActivity, moving it to Announced. During election phases the Activity remains Announced. After announcement, generic updateActivity is unavailable; cancellation is only through the election-specific voidElection transition before voting. No Activity command may change the ballot, ballotChannel, voting mode, dates or electorate of an announced election.

| From | Command | To | Notes |
| --- | --- | --- | --- |
| [*] | createElection | Planned | Creates an Activity in Planned state and an election record. Stores the election type, unit, positions, seats, ballot type, ballotChannel, mode and dates. An open required value blocks creation. |
| Planned | announceElection (announceActivity) | Announced | Announces the Activity and sends notices. This freezes ballot type, channel, mode, dates and certifier method. Generic updateActivity is no longer available. The voting-system preset and permitted parameters are frozen when nominations open. |
| Announced | openNominations | Nominations | Opens at the announced date. |
| Planned, Announced or Nominations | voidElection | Void | Before voting only. Records a reason, sends a notice and prevents further changes. This is the election's cancellation path; generic cancelActivity is not available after announcement. |
| Nominations | startVoting | Voting or Void | At cut-off, writes the frozen electorate. If there are too few eligible candidates for the seats, records the reason and enters Void instead. |
| Voting | closeVoting | Counting or Void | At the announced deadline (or chair action in meeting mode). Casting checks Voting and that the deadline has not passed. If quorum is met, enter Counting; otherwise record failed quorum and enter Void. |
| Counting | countElection (job) | Voting | A preset runoff opens a new round among its declared candidates with the same electorate. A majority-with-runoff preset's own second round is not a tie-break-chain runoff. |
| Counting | settleTie | Counting | Applies the next tie-break-chain rule. A committee may fail to decide; then the chain proceeds to its terminal lot. |
| Counting | certifyElection | Certified or Void | A passing certification writes the immutable result. A no or deadline outcome of no enters Void with the refusal reason. If all declared certifiers are candidates, escalate to the nearest parent-unit certifier subject set with an eligible certifier; continue up the tree as needed. At the root use Admin (audited). If no fallback certifier can decide, enter Void with that reason. |
| Certified | seatElected (job) | Seated | At term start, System(elections) creates role assignments whose origin is the certification. |

- **Certification** is the election's final decision in ADR 0011's decision-record construct. The election type declares a certifier subject set and decision rule; the announcer cannot choose certifiers. The chosen committee method is a motion vote of the unit before announcement, not an authority decision of its leader. A person is not excluded merely because a candidate nominated them for the committee; appointment is collective and only a candidate is recused from their own certification. A meeting chair may instead be selected by a motion vote at the meeting and certifies alone. The committee passes by majority of its eligible, non-candidate certifiers; a tie or no is failure. Failure or deadline outcome no means no certification and transitions to Void. If every declared certifier is a candidate, escalate to the parent unit's declared certifier subject set; continue up the unit tree as needed and use Admin at the root. Admin fallback is audited. If no eligible fallback certifier can decide, the election enters Void with a reason.
- `System(elections)` is its own principal (ADR 0008). Its grants cover scheduled lifecycle steps, counting, seating and retention; it cannot nominate, certify or decide a tie for the committee.
- **Elected positions cannot bypass elections.** An election type declares each elected position by unit kind and role kind. Only a certified election may create or extend a role assignment in that position. `createMembership`, `extendMembership` and leader-flag changes do not grant elected positions. Admin is the explicit exception: an Admin may make an audited assignment for a vacancy, with no automatic renewal. A unit that does not elect a position keeps ADR 0011's authority decisions for it.

- **Elected roles do not renew automatically.** A certification approves no renewal plan. This overrides ADR 0011's renewal defaults for elected roles. When the term ends, the role assignment ends. What happens until a successor is seated (holdover) is an open question.
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

A threshold is a fraction with a preset default. Its denominator is selected from one closed set: valid ballots (default), all ballots cast including blanks, checked-in attendees, or the whole frozen electorate. A blank is not a valid ballot; an abstention is valid and counts in the denominator when the chosen denominator is valid ballots, but is not a yes vote. Whether an abstention should instead be excluded for a given motion is a bylaw value. Quorum is separate: the share of the frozen electorate that must be present (meeting) or must have voted (remote).

**Tie-break chain.** A typed chain is zero or more non-deciding rules followed by exactly one terminal that always decides. Runoff, seniority and committee are non-deciding rules; a committee may be absent or fail to decide. The terminal is a recorded lot. The default chain is runoff → committee → lot.

**Presets.** A named voting system is a declared tuple with sensible defaults for threshold and denominator. The bylaws select a preset per elected position; an election type declares which presets and parameter ranges its instances may use. The preset and allowed parameters are frozen when nominations open.

| Preset | Ballot | Aggregation | Win condition | Seats |
| --- | --- | --- | --- | --- |
| Plurality | Single choice | Count | Plurality | 1 |
| Majority with runoff | Single choice | Count | First round: more than half; otherwise the top two advance (all tied at second place advance). Second round: plurality; a tie uses the tie-break chain. The preset's second round does not use the tie-break-chain runoff allowance. | 1 |
| Instant runoff (IRV) | Ranked | Elimination rounds | Majority of the continuing ballots | 1 |
| Single transferable vote (STV) | Ranked | Elimination rounds | Droop quota floor(V/(s+1))+1 (V = valid ballots); WIGM surplus transfer, truncated to five decimal places | 1 or more |
| Approval | Approval | Count | Highest sum | 1 or more |
| Score | Score | Sum or mean | Highest sum or mean | 1 or more |
| Majority judgment | Grade | Median grade | Highest median grade, then majority value (iterative median-grade removal) | 1 |
| Schulze | Ranked | Pairwise matrix | Schulze winner | 1 |
| Motion | Yes/no/abstain | Count | Threshold | n/a |

**Exact STV preset.** V is the number of valid ballots, and the Droop quota is fixed for the count: floor(V/(s+1))+1. This preset uses WIGM as specified by rules 48–50 of the [Scottish Local Government Elections Order 2011](https://www.legislation.gov.uk/ssi/2011/399/made): transfer value = truncate to five decimal places (surplus × the ballot's current value / the candidate's total vote). The linked order is the source for the transfer variant and rounding precision.

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

- **Casting.** On Web, an authenticated Elector(e) uses castBallot. On SlackDM, castVote uses a single-use Link with purpose "ballot", bound to that elector, election and round. Both check the Voting state, deadline, frozen Elector(e) membership and one-vote-per-round record before storing a ballot. A secret instance never writes an open vote.
- **Counting** reads the ballots in shuffled order. When voting closes, the job writes the ballots again in one new transaction, in random order, and deletes the first copies. The stored ballots then carry no order of arrival and one shared transaction id.
- **No tally** is readable before voting closes, for either kind.
- The payload of a ballot never enters the audit log or any application log. This follows the audit rule that the log keeps no changed values (`docs/system/administration.md`). No command reads a secret ballot, except the count.
- **Unlinkability is a schema property.** No column of the secret-ballot table references a person or a participation row, and the table has no time column and no running number. A generated schema check fails when one appears.
- **An open ballot** records the voter and the choice. It is the same as a show of hands, with a record.

**Residual trust in operators and processors.** An authorized operator with database, platform, deployment, request-log or managed-database history access may link ballots to voters during voting and while pre-shuffle state remains in WAL, backups, PITR or logs; an operator may also alter the counting code. Voters cannot verify their ballots. The people with this access may themselves be electors or candidates. The duration of that exposure depends on retention policies that this ADR does not verify. In SlackDM mode, Slack receives the Slack user identity together with the ballot choice; workspace owners may access or export both, and Slack may retain them under its processor policies. The Web schema unlinkability property does not hide a SlackDM vote from Slack. These are explicit trust limits, not covered by ADR 0011's Emergency reset decision.

## Personal data

Each field below is declared in `packages/domain` with its purpose, legal basis and retention (ADR 0004). This table is the proposal for that declaration. The legal basis is for the privacy owner to confirm.

| Data | Purpose | Kept for |
| --- | --- | --- |
| Electorate rows, check-ins, participation | Check who may vote and who has voted; the quorum | Until the appeal window ends, then deleted |
| Secret ballots and open votes | Count the ballots; a recount in the appeal window | Until the appeal window ends, then deleted |
| SlackDM delivery and ballot data (Slack processor) | Deliver and accept a Slack ballot | Delete the Slack message at the end of the appeal window where the API permits; workspace exports and provider-retained copies may remain. Confirm terms, deletion limits and legal basis under ADR 0004. |
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
7. **Authority and no escalation.** Each role assignment in an elected position has either a passed certification or an audited Admin vacancy grant as its origin. An Admin vacancy grant has no renewal plan. A passed election certification is an explicit exception to ADR 0011's no-escalation check, like an Admin grant; this resolves ADR 0011 question 2 for elections only.

## Values that depend on the bylaws

The bylaws (vedtekter) are not available. All values below are in one declaration in `packages/domain`. Each has a status. An **assumed** value is used, and every document that shows it shows the marker. An **open** value has no value: the command that needs it refuses and names it. Tests and docs read the declaration, never a literal. When the bylaws arrive, one declaration changes and the status says which paragraph the value comes from.

| Value | Status | Value now |
| --- | --- | --- |
| Quorum, and what it counts | open | none |
| Who may nominate | assumed | Before the cut-off, a current TeamMember in the live scope subtree may nominate themself or another person; every nominee must accept. |
| Candidate eligibility | open | The bylaws decide who may stand. No election can open nominations until this required value is set. |
| Voting system, per position | assumed | Team leader: majority with runoff. Board: `leader` by majority with runoff, then `member` seats by STV |
| Seats of a board, and their bounds | open | none |
| Term length | assumed | Two semesters (one year) for each type; one semester is allowed by the declaration |
| Holdover until a successor is seated | open | none |
| Election committee or chair | open | The bylaws select the declared certifier subject set. Committee appointment by unit motion vote before announcement and chair election by meeting motion vote are the available methods. |
| Certification deadline | open | The deadline duration is set by the bylaws; the rule's deadline outcome is no, which moves the instance to Void with a recorded reason. |
| Denominator choices | assumed | Valid ballots (default), all ballots cast including blank, checked-in attendees, or whole frozen electorate. A blank ballot is invalid; an abstention is valid. |
| Abstention treatment | open | The bylaws decide whether an abstention counts in the denominator for a motion threshold. |
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
- **Other decisions.** On acceptance, ADR 0011 gets revision lines: its `Vote` rule is named **motion vote**; its electorate question 1 is resolved for elections; elected assignments have no renewal; a certification may authorise a later `System(elections)` seating command; and no-escalation has an explicit certification exception. Its `createMembership` and `extendMembership` grant rows, including grants that set the leader flag, exclude positions declared elected by an election type. Only a passed certification can create or extend those assignments; an Admin may make an audited vacancy assignment. Other positions retain the unit's existing authority decisions. The Team entity of spec 0006 requires a department; the national board team under the root follows ADR 0011's unit tree.

## Open questions

1. **Holdover.** Does the outgoing leader stay in the role until a successor is seated? Without it, a unit with no seated leader has no leader, and ADR 0011 question 6 applies.
2. **Vacancy.** A leader or board member resigns during a term. Does the unit require a by-election, or use the audited Admin vacancy exception defined above? The Admin exception itself is decided.
3. **Failed elections.** No candidates, too few eligible candidates for the seats, or failed quorum moves the instance to `Void` and records the reason. May a void instance be reopened, or must the unit announce a new instance?
4. **Appeals.** A certified result cannot change. What does an upheld appeal do? Proposal: a decision of the certifiers voids the election, and a new election follows.
5. **Electors without an Active account.** A member with no way to sign in is in the frozen electorate. May the chair record a vote for them?
6. **Conflicts of interest.** A candidate cannot certify their own election. What other duties may candidates hold during the election, and how is recusal enforced?
7. **Visibility.** Who may read open votes, and when? Proposal: the certifiers and the electorate, after the count. Are the tallies of each round kept after the ballots are deleted? They are not personal data about a voter, but they show a candidate's support.
8. **The root teams.** By the electorate rule, the members of teams directly under the root, among them the national board itself, vote in the national board election. Does the operator confirm that?
9. **Labels of board seats.** Are "nestleder" and "kasserer" voted for as positions, or does the elected board set the labels after seating? Labels never give a permission (ADR 0011), so both work.
10. **Several positions.** May a person stand for the leader and a member seat at once? Assumption: positions are counted in order, and an elected person leaves the later counts.
11. **Which units elect.** Does every team elect its leader, or only some teams? The election type applies to a unit, and the bylaws decide which units use it.
12. **Presence in a meeting.** How does the system know that a person who checks in is in the room: the chair confirms, or a code on the screen in the room?
13. **National board authority.** Which grants belong to the national board, including the privacy owner's authority, and how does `Fn(board, *)` apply to the root team? This relates to ADR 0011 question 5 about the root `leader` role.

Source: operator decisions, 2026-10-27. The national board as a team under the root is operator input, 2026-10-27.
