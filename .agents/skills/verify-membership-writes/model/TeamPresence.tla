----------------------------- MODULE TeamPresence -----------------------------
(***************************************************************************)
(* Spec 0032: Person before Team, shared presence admission versus the      *)
(* NO KEY UPDATE lock of deactivateTeam's UPDATE. The existing membership *)
(* model retains term/overlap semantics; this companion models the added  *)
(* lock and activity decision, at statement boundaries. Two Persons and   *)
(* one Team expose compatible shared holders as well as exclusive waits. *)
(* Authority and term admissibility are assumed here; this companion      *)
(* checks Team activity only, not every reason a membership may refuse.   *)
(* create/extend/moveTo: Person lock, FOR SHARE, activity read, membership *)
(* write, commit. end/cancel/moveAway model exits from this Team; a move's *)
(* destination admission is the moveTo program. deactivate takes only the *)
(* Team lock, writes, commits. Cancellation releases locks and rolls back.*)
(* Sources: teams/domain/commands.ts createMembership/changeMembership/   *)
(* extendMembership; repositories/teams.ts holdPresence and deactivate.   *)
(* SQL witnesses and 300-round races: declaredLifecycles.postgres.test.ts. *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS Txns, NoTxn, Code

OrderedPresence == [share |-> TRUE, reverse |-> FALSE, blockExits |-> FALSE]
MissingPresenceLock == [OrderedPresence EXCEPT !.share = FALSE]
TeamBeforePerson == [OrderedPresence EXCEPT !.reverse = TRUE]
BlockedInactiveExits == [OrderedPresence EXCEPT !.blockExits = TRUE]

Presence == {"create", "extend", "moveTo"}
Exits == {"end", "cancel", "moveAway"}
Kinds == Presence \cup Exits \cup {"deactivate"}
Plans == [kind : Kinds, person : 1..2]

Steps(kind) ==
    IF kind = "deactivate" THEN <<"exclusive", "write", "commit">>
    ELSE IF kind \in Presence THEN
        (IF Code.reverse THEN <<"share", "person">> ELSE <<"person", "share">>)
            \o <<"readActive", "write", "commit">>
    ELSE <<"person">> \o (IF Code.blockExits THEN <<"readActive">> ELSE <<>>)
            \o <<"write", "commit">>

VARIABLES plan, pc, status, personOwner, shared, exclusive, active, events
vars == <<plan, pc, status, personOwner, shared, exclusive, active, events>>
Running(t) == status[t] = "running"
At(t, op) == Running(t) /\ pc[t] <= Len(Steps(plan[t].kind)) /\ Steps(plan[t].kind)[pc[t]] = op
Advance(t) == pc' = [pc EXCEPT ![t] = @ + 1]
Finish(t, result) ==
    /\ status' = [status EXCEPT ![t] = result]
    /\ personOwner' = [p \in 1..2 |-> IF personOwner[p] = t THEN NoTxn ELSE personOwner[p]]
    /\ shared' = shared \ {t}
    /\ exclusive' = IF exclusive = t THEN NoTxn ELSE exclusive

Init ==
    /\ plan \in [Txns -> Plans]
    /\ pc = [t \in Txns |-> 1]
    /\ status = [t \in Txns |-> "running"]
    /\ personOwner = [p \in 1..2 |-> NoTxn]
    /\ shared = {}
    /\ exclusive = NoTxn
    /\ active = TRUE
    /\ events = <<>>

LockPerson(t) ==
    /\ At(t, "person") /\ personOwner[plan[t].person] \in {NoTxn, t}
    /\ personOwner' = [personOwner EXCEPT ![plan[t].person] = t]
    /\ Advance(t)
    /\ UNCHANGED <<plan, status, shared, exclusive, active, events>>

LockShare(t) ==
    /\ At(t, "share") /\ (~Code.share \/ exclusive \in {NoTxn, t})
    /\ shared' = IF Code.share THEN shared \cup {t} ELSE shared
    /\ Advance(t)
    /\ UNCHANGED <<plan, status, personOwner, exclusive, active, events>>

LockExclusive(t) ==
    /\ At(t, "exclusive") /\ exclusive \in {NoTxn, t} /\ shared \subseteq {t}
    /\ exclusive' = t
    /\ Advance(t)
    /\ UNCHANGED <<plan, status, personOwner, shared, active, events>>

ReadActive(t) ==
    /\ At(t, "readActive")
    /\ IF active THEN
          /\ Advance(t)
          /\ UNCHANGED <<plan, status, personOwner, shared, exclusive, active, events>>
       ELSE
          /\ Finish(t, "refused")
          /\ UNCHANGED <<plan, pc, active, events>>

Write(t) ==
    /\ At(t, "write") /\ Advance(t)
    /\ UNCHANGED <<plan, status, personOwner, shared, exclusive, active, events>>

Commit(t) ==
    /\ At(t, "commit") /\ Finish(t, "committed")
    /\ active' = IF plan[t].kind = "deactivate" THEN FALSE ELSE active
    /\ events' = Append(events, plan[t].kind)
    /\ UNCHANGED <<plan, pc>>

Cancel(t) ==
    /\ Running(t) /\ Finish(t, "cancelled")
    /\ UNCHANGED <<plan, pc, active, events>>

Done == \A t \in Txns : ~Running(t)
Next ==
    \/ \E t \in Txns : LockPerson(t) \/ LockShare(t) \/ LockExclusive(t) \/ ReadActive(t) \/ Write(t) \/ Commit(t) \/ Cancel(t)
    \/ Done /\ UNCHANGED vars
Spec == Init /\ [][Next]_vars

Waits(t, u) ==
    /\ Running(t) /\ Running(u) /\ t # u
    /\ \/ At(t, "person") /\ personOwner[plan[t].person] = u
       \/ At(t, "share") /\ Code.share /\ exclusive = u
       \/ At(t, "exclusive") /\ (exclusive = u \/ u \in shared)

NoWaitCycle ==
    /\ ~\E t,u \in Txns : Waits(t,u) /\ Waits(u,t)
    /\ ~\E t,u,v \in Txns : Waits(t,u) /\ Waits(u,v) /\ Waits(v,t)
PresenceOrder == \A t \in shared : personOwner[plan[t].person] = t
NoPostDeactivatePresence ==
    \A i,j \in DOMAIN events : (i < j /\ events[i] = "deactivate") => events[j] \notin Presence
ExitsNeverRefused == \A t \in Txns : plan[t].kind \in Exits => status[t] # "refused"
NeverTeamWait == ~\E t,u \in Txns : Waits(t,u) /\ (At(t,"share") \/ At(t,"exclusive"))
NeverPresenceCommit == \A i \in DOMAIN events : events[i] \notin Presence
NeverInactiveExit == ~\E i,j \in DOMAIN events : i < j /\ events[i] = "deactivate" /\ events[j] \in Exits
TypeOK ==
    /\ plan \in [Txns -> Plans]
    /\ pc \in [Txns -> 1..6]
    /\ status \in [Txns -> {"running", "committed", "refused", "cancelled"}]
    /\ personOwner \in [1..2 -> Txns \cup {NoTxn}]
    /\ shared \subseteq Txns
    /\ exclusive \in Txns \cup {NoTxn}
    /\ active \in BOOLEAN
    /\ events \in Seq(Kinds) /\ Len(events) <= Cardinality(Txns)
TxnSymmetry == Permutations(Txns)
=============================================================================
