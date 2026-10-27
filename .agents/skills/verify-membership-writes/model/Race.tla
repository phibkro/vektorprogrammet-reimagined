-------------------------------- MODULE Race --------------------------------
(***************************************************************************)
(* The race: one person, the commands of packages/domain/src/teams/        *)
(* commands.ts that write memberships, in every combination and every      *)
(* interleaving. The person has an Active membership (r0, semesters 1 to 2 *)
(* in team x) and a Planned one (r1, semester 3 in team y). The current    *)
(* semester is 2. Semesters run from 1 to 4; two teams (x, y) show that    *)
(* the constraint compares terms inside one team only.                     *)
(***************************************************************************)
EXTENDS MembershipWrites, Shapes, TLC

CONSTANTS r0, r1    \* the rows that exist before the race (model values)

RaceRows == {
    [id |-> r0, person |-> 1, team |-> "x", s |-> 1, e |-> 2],
    [id |-> r1, person |-> 1, team |-> "y", s |-> 3, e |-> 3] }

Plan(kind, row, team, s, e, from, team2) ==
    [kind |-> kind, row |-> row, person |-> 1, person2 |-> 0, team |-> team,
     s |-> s, e |-> e, from |-> from, team2 |-> team2]

Teams == {"x", "y"}

\* addMember: a term that starts now or later (declaration.ts:265-277).
AddMembers ==
    { p \in { Plan("addMember", NoRow, tm, s, e, 0, "-") : tm \in Teams, s \in 2..4, e \in 2..4 } :
        p.s <= p.e }

Extends == { Plan("extend", r0, "-", 0, e, 0, "-") : e \in 3..4 }

EndsEarly == { Plan("endEarly", r0, "-", 0, 0, 2, "-") }

Changes == { Plan("change", r0, "-", 0, 0, 2, tm) : tm \in Teams }

Cancels == { Plan("cancel", r1, "-", 0, 0, 0, "-") }

RacePlans == AddMembers \cup Extends \cup EndsEarly \cup Changes \cup Cancels

TxnSymmetry == Permutations(Txns)

=============================================================================
