-------------------------------- MODULE Race --------------------------------
(***************************************************************************)
(* The race: one person, the commands of packages/domain/src/teams/        *)
(* commands.ts that write memberships, and the commands that lock the      *)
(* admin list first (createAdminGrant and deleteAdminGrant; the account    *)
(* commands deactivateAccount and reactivateAccount take the same two      *)
(* locks), in every combination and every interleaving.                    *)
(* The person has an Active membership (r0, semesters 1 to 2 in team x)    *)
(* and a Planned one (r1, semester 3 in team y). The current semester is   *)
(* 2. Semesters run from 1 to 4; two teams (x, y) show that the constraint *)
(* compares terms inside one team only.                                    *)
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

\* createMembership: a term that starts now or later (declaration.ts:288-301).
AddMembers ==
    { p \in { Plan("createMembership", NoRow, tm, s, e, 0, "-") : tm \in Teams, s \in 2..4, e \in 2..4 } :
        p.s <= p.e }

Extends == { Plan("extendMembership", r0, "-", 0, e, 0, "-") : e \in 3..4 }

EndsEarly == { Plan("endEarlyMembership", r0, "-", 0, 0, 2, "-") }

Changes == { Plan("changeMembership", r0, "-", 0, 0, 2, tm) : tm \in Teams }

Cancels == { Plan("deleteMembership", r1, "-", 0, 0, 0, "-") }

\* They write admin_grant, not membership: what they add to the race is the
\* locks they hold, the admin list's and then the person's.
AdminCommands == { Plan("createAdminGrant", NoRow, "-", 0, 0, 0, "-"),
                   Plan("deleteAdminGrant", NoRow, "-", 0, 0, 0, "-") }

RacePlans == AddMembers \cup Extends \cup EndsEarly \cup Changes \cup Cancels
                \cup AdminCommands

TxnSymmetry == Permutations(Txns)

=============================================================================
