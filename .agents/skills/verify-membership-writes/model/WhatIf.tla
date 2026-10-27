------------------------------- MODULE WhatIf -------------------------------
(***************************************************************************)
(* What the rule "take the person's lock before any write" protects: a     *)
(* command that the code does not have, `replace`, which cancels a Planned *)
(* membership and adds another one in its place in one transaction. The    *)
(* other commands are the real ones that can meet it: addMember and cancel *)
(* on the same person. Same world as Race.tla.                             *)
(***************************************************************************)
EXTENDS Race

Replaces == { Plan("replace", r1, "y", 3, 3, 0, "-") }

WhatIfPlans == AddMembers \cup Cancels \cup Replaces

=============================================================================
