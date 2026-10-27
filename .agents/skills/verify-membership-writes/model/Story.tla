------------------------------- MODULE Story --------------------------------
(***************************************************************************)
(* The smallest scenario that tells the R6 deadlock (spec 0006 R6): two    *)
(* leaders add the same person to the same team for the same semester at   *)
(* once, and the person has no membership yet. Its state graph is small    *)
(* enough to draw. Use it as the pattern for a scenario of your own: take  *)
(* the plans that a counterexample used (they are in its first state) and  *)
(* list them in `StoryPlans`.                                              *)
(***************************************************************************)
EXTENDS Race

StoryRows == {}

StoryPlans == { Plan("addMember", NoRow, "x", 2, 2, 0, "-") }

=============================================================================
