-------------------------------- MODULE Pair --------------------------------
(***************************************************************************)
(* Two persons, and commands that lock both (a merge, a cross-department   *)
(* change): AggregateLocks.lockAll over two ids. No command does that yet, *)
(* so this module checks the lock construct and not a command. Both        *)
(* commands name the same two persons, in opposite order.                  *)
(***************************************************************************)
EXTENDS MembershipWrites, Shapes, TLC

PairPlan(a, b) ==
    [kind |-> "lockBoth", row |-> NoRow, person |-> a, person2 |-> b, team |-> "-",
     s |-> 0, e |-> 0, from |-> 0, team2 |-> "-"]

PairPlans == { PairPlan(1, 2), PairPlan(2, 1) }

PairRows == {}

TxnSymmetry == Permutations(Txns)

=============================================================================
