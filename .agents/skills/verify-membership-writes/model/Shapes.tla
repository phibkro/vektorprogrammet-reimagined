------------------------------- MODULE Shapes -------------------------------
(***************************************************************************)
(* The code, as MembershipWrites.tla sees it: which statements each        *)
(* repository write runs and in which order, and which commands call which *)
(* repository writes. `CurrentCode` is the code at the digest-confirmed tree *)
(* in SKILL.md; every line points at the code that a reviewer can open.    *)
(* The other records are broken variants: each is `CurrentCode` with one   *)
(* edit that the code could get, and the comment says which.               *)
(*                                                                         *)
(* A statement name is one step of the model:                              *)
(*   read              a plain SELECT of the membership and the machine's  *)
(*                     decision on it (no lock)                            *)
(*   lockPerson        SELECT ... FROM person WHERE id = :person           *)
(*                     FOR NO KEY UPDATE                                   *)
(*   lockPersonOfRow   the same through a join on the membership's id      *)
(*   insertRow         INSERT INTO membership                              *)
(*   updateEnd         UPDATE membership SET end ... WHERE <setEndWhere>   *)
(*   deleteRow         DELETE FROM membership WHERE <removeWhere>          *)
(***************************************************************************)
EXTENDS Sequences

CurrentCode == [
    \* packages/domain/src/teams/commands.ts: the repository calls of each
    \* handler, in order (each handler runs in one transaction,
    \* packages/db/src/transactional.ts:20-37).
    compose |-> [
        addMember |-> <<"insert">>,                 \* commands.ts:185
        cancel    |-> <<"read", "remove">>,         \* commands.ts:208-214 (beginTransition reads at 115)
        change    |-> <<"read", "setEnd", "insert">>, \* commands.ts:249, 263, 270
        endEarly  |-> <<"read", "setEnd">>,         \* commands.ts:332, 338
        extend    |-> <<"read", "setEnd">>          \* commands.ts:360, 366
    ],
    \* packages/db/src/repositories/teams.ts, MembershipRepositoryLive: the
    \* statements of each method, in order.
    repo |-> [
        read   |-> <<"read">>,                      \* commands.ts:86, 115-132
        insert |-> <<"lockPerson", "insertRow">>,   \* teams.ts:437-442, 444-461
        setEnd |-> <<"lockPersonOfRow", "updateEnd">>, \* teams.ts:480-486, 488-504
        remove |-> <<"deleteRow">>                  \* teams.ts:521-535 (no lock)
    ],
    \* The WHERE clauses of the conditional writes. A statement that matches no
    \* row is `lostRace`, the typed Conflict (teams.ts:310-315, 506-510, 537-539).
    setEndWhere |-> {"id", "end=observed", "start<=current", "end>=current"}, \* teams.ts:491-498
    removeWhere |-> {"id", "start=observed", "end=observed", "start>current"}, \* teams.ts:523-533
    \* membership_no_overlap: EXCLUDE USING gist (person_id WITH =, team_id WITH =,
    \* int4range(start_ordinal, end_ordinal, '[]') WITH &&)
    exclusion |-> TRUE,                             \* packages/db/drizzle/20261026221817_membership_no_overlap/migration.sql:6-10
    \* What the caller is told for each SQLSTATE that a write can meet.
    on23P01 |-> "AlreadyExists",                    \* classifySqlFailure.ts:95-120, 126-145
    on40P01 |-> "defect"                            \* classifySqlFailure.ts: no case; test classifySqlFailure.test.ts:51
]

(***************************************************************************)
(* Broken variants of the code. Each is the real code with one edit.       *)
(***************************************************************************)

\* Before the fix of spec 0006 R6: insert does not take the person's lock.
InsertWithoutLock ==
    [CurrentCode EXCEPT !.repo = [CurrentCode.repo EXCEPT !.insert = <<"insertRow">>]]

\* setEnd does not take the person's lock (the extension and insert race of R6).
SetEndWithoutLock ==
    [CurrentCode EXCEPT !.repo = [CurrentCode.repo EXCEPT !.setEnd = <<"updateEnd">>]]

\* insert writes first and takes the lock afterwards: the opposite order.
InsertLocksAfterWrite ==
    [CurrentCode EXCEPT !.repo = [CurrentCode.repo EXCEPT !.insert = <<"insertRow", "lockPerson">>]]

\* The UPDATE of setEnd no longer names the end that the command read.
SetEndWithoutObservedEnd ==
    [CurrentCode EXCEPT !.setEndWhere = {"id", "start<=current", "end>=current"}]

\* The UPDATE of setEnd is only `WHERE id = :id` (the negative control of
\* teams.postgres.test.ts, falsifier 3).
SetEndUnconditional ==
    [CurrentCode EXCEPT !.setEndWhere = {"id"}]

\* The exclusion constraint is dropped (the negative control of falsifier 4).
NoExclusionConstraint == [CurrentCode EXCEPT !.exclusion = FALSE]

\* The caller is told "already exists" for a deadlock victim too, as if 40P01
\* meant that the other write won. Only visible together with a missing lock.
DeadlockMappedToAlreadyExists == [InsertWithoutLock EXCEPT !.on40P01 = "AlreadyExists"]

(***************************************************************************)
(* What-if commands that the code does not have. Not covered code: they    *)
(* show what the rule "take the person's lock before any write" buys.      *)
(***************************************************************************)

Kinds == {"addMember", "cancel", "change", "endEarly", "extend", "replace"}

\* A command that cancels a planned membership and adds another one in the same
\* transaction, written the obvious way: remove, then insert.
WithReplace == [CurrentCode EXCEPT !.compose =
    [k \in Kinds |-> IF k = "replace" THEN <<"read", "remove", "insert">>
                     ELSE CurrentCode.compose[k]]]

\* The same command taking the person's lock first.
WithReplaceLockedFirst == [CurrentCode EXCEPT
    !.repo = [read   |-> <<"read">>,
              insert |-> CurrentCode.repo.insert,
              setEnd |-> CurrentCode.repo.setEnd,
              remove |-> CurrentCode.repo.remove,
              lock   |-> <<"lockPersonOfRow">>],
    !.compose =
    [k \in Kinds |-> IF k = "replace" THEN <<"read", "lock", "remove", "insert">>
                     ELSE CurrentCode.compose[k]]]

\* Spec 0006b contract 1 ("every write to an owned table takes the lock"): the
\* delete of `remove` locks the person too, so the new command is safe without
\* its author remembering anything.
WithReplaceAllWritesLocked == [WithReplace EXCEPT !.repo =
    [WithReplace.repo EXCEPT !.remove = <<"lockPersonOfRow", "deleteRow">>]]

(***************************************************************************)
(* Spec 0006b contract 2, on two persons. Not covered code: the spec is    *)
(* frozen on branch chore/races-by-construction and no code exists yet.    *)
(* A command that locks two persons ("merge", a cross-department change).  *)
(***************************************************************************)

\* The two locks in the order that the caller names the persons.
LocksInCallOrder == [CurrentCode EXCEPT
    !.repo = [first |-> <<"lockPerson">>, second |-> <<"lockSecondPerson">>],
    !.compose = [lockBoth |-> <<"first", "second">>]]

\* `Aggregate.lockAll`: the lower id first, then the higher one.
LocksInIdOrder == [CurrentCode EXCEPT
    !.repo = [lower |-> <<"lockLowerPerson">>, higher |-> <<"lockHigherPerson">>],
    !.compose = [lockBoth |-> <<"lower", "higher">>]]

=============================================================================
