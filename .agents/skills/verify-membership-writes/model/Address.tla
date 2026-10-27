------------------------------ MODULE Address ------------------------------
(***************************************************************************)
(* Two projection transactions each lock two Persons and claim two        *)
(* company addresses. Person locks are taken in ascending id order before *)
(* any address claim; claims are taken in address order. A unique insert   *)
(* waits for an unfinished claimant, then returns no row on commit or can *)
(* claim after rollback (membershipWriteModel.postgres.test.ts). A profile *)
(* or team edit takes at most one address, so it cannot reverse address   *)
(* order. Code selects the real order or a broken opposite-order variant.  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Txns, NoTxn, Code
SortedAddresses == TRUE
OppositeAddresses == FALSE

Plans == {
    [people |-> <<1, 2>>, addresses |-> <<1, 2>>],
    [people |-> <<3, 4>>, addresses |-> IF Code THEN <<1, 2>> ELSE <<2, 1>>]
}

VARIABLES plan, pc, status, personOwner, addressOwner
vars == <<plan, pc, status, personOwner, addressOwner>>

Init ==
    /\ plan \in [Txns -> Plans]
    /\ pc = [t \in Txns |-> 1]
    /\ status = [t \in Txns |-> "running"]
    /\ personOwner = [p \in 1..4 |-> NoTxn]
    /\ addressOwner = [a \in 1..2 |-> NoTxn]

Running(t) == status[t] = "running"
PersonKey(t) == plan[t].people[pc[t]]
AddressKey(t) == plan[t].addresses[pc[t] - 2]

LockPerson(t) ==
    /\ Running(t) /\ pc[t] \in 1..2
    /\ personOwner[PersonKey(t)] = NoTxn
    /\ personOwner' = [personOwner EXCEPT ![PersonKey(t)] = t]
    /\ pc' = [pc EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<plan, status, addressOwner>>

ClaimAddress(t) ==
    /\ Running(t) /\ pc[t] \in 3..4
    /\ addressOwner[AddressKey(t)] = NoTxn
    /\ addressOwner' = [addressOwner EXCEPT ![AddressKey(t)] = t]
    /\ pc' = [pc EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<plan, status, personOwner>>

RefuseAddress(t) ==
    /\ Running(t) /\ pc[t] \in 3..4
    /\ addressOwner[AddressKey(t)] \in Txns
    /\ status[addressOwner[AddressKey(t)]] = "committed"
    /\ status' = [status EXCEPT ![t] = "conflict"]
    /\ personOwner' = [p \in 1..4 |-> IF personOwner[p] = t THEN NoTxn ELSE personOwner[p]]
    /\ addressOwner' = [a \in 1..2 |-> IF addressOwner[a] = t THEN NoTxn ELSE addressOwner[a]]
    /\ UNCHANGED <<plan, pc>>

Commit(t) ==
    /\ Running(t) /\ pc[t] = 5
    /\ status' = [status EXCEPT ![t] = "committed"]
    /\ personOwner' = [p \in 1..4 |-> IF personOwner[p] = t THEN NoTxn ELSE personOwner[p]]
    /\ UNCHANGED <<plan, pc, addressOwner>>

Terminal == \A t \in Txns : ~Running(t)
Next ==
    \/ \E t \in Txns : LockPerson(t) \/ ClaimAddress(t) \/ RefuseAddress(t) \/ Commit(t)
    \/ Terminal /\ UNCHANGED vars
Spec == Init /\ [][Next]_vars

WaitsFor(t) ==
    IF ~Running(t) THEN NoTxn
    ELSE IF pc[t] \in 1..2 THEN personOwner[PersonKey(t)]
    ELSE IF pc[t] \in 3..4 THEN
        LET owner == addressOwner[AddressKey(t)]
        IN IF owner \in Txns /\ Running(owner) THEN owner ELSE NoTxn
    ELSE NoTxn

NoWaitCycle ==
    ~\E t, u \in Txns : t # u /\ WaitsFor(t) = u /\ WaitsFor(u) = t
NeverConflict == \A t \in Txns : status[t] # "conflict"
TypeOK ==
    /\ plan \in [Txns -> Plans]
    /\ pc \in [Txns -> 1..5]
    /\ status \in [Txns -> {"running", "committed", "conflict"}]
    /\ personOwner \in [1..4 -> Txns \cup {NoTxn}]
    /\ addressOwner \in [1..2 -> Txns \cup {NoTxn}]
TxnSymmetry == Permutations(Txns)
=============================================================================
