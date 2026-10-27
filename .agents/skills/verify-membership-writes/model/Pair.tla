-------------------------------- MODULE Pair --------------------------------
(***************************************************************************)
(* Two persons, and commands that lock both ("merge", a cross-department   *)
(* change). Design scenario for spec 0006b contract 2: there is no code    *)
(* for it yet, so this module is not covered code. Both commands name the  *)
(* same two persons, in opposite order.                                    *)
(***************************************************************************)
EXTENDS MembershipWrites, Shapes, TLC

PairPlan(a, b) ==
    [kind |-> "lockBoth", row |-> NoRow, person |-> a, person2 |-> b, team |-> "-",
     s |-> 0, e |-> 0, from |-> 0, team2 |-> "-"]

PairPlans == { PairPlan(1, 2), PairPlan(2, 1) }

PairRows == {}

TxnSymmetry == Permutations(Txns)

=============================================================================
