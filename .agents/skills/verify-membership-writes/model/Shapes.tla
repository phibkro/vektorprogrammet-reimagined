------------------------------- MODULE Shapes -------------------------------
(***************************************************************************)
(* The code, as MembershipWrites.tla sees it: which statements each call   *)
(* that a command makes runs and in which order, and which calls each      *)
(* command makes. `CurrentCode` is the code at the digest-confirmed tree   *)
(* in SKILL.md; every line points at the code that a reviewer can open.    *)
(* The other records are broken variants: each is `CurrentCode` with one   *)
(* edit that the code could get (or, where the code stays safe with one    *)
(* edit, the edits that break it together), and the comment says which.    *)
(*                                                                         *)
(* A statement name is one step of the model:                              *)
(*   find              MembershipRepository.findById: a plain SELECT       *)
(*                     without a lock (it finds whose lock to take)        *)
(*   read              MembershipRepository.findLocked: a plain SELECT     *)
(*                     through the lock's token, and the machine's         *)
(*                     decision on it                                      *)
(*   lockPerson        SELECT id FROM person WHERE id IN (:person)         *)
(*                     ORDER BY id FOR NO KEY UPDATE (AggregateLocks.lock) *)
(*   lockPersonOfRow   the same for the person that the membership found   *)
(*                     by `find` belongs to                                *)
(*   lockAdminList     the same on the admin list's one row                *)
(*   insertRow         INSERT INTO membership                              *)
(*   updateEnd         UPDATE membership SET end ... WHERE <setEndWhere>   *)
(*   deleteRow         DELETE FROM membership WHERE <removeWhere>          *)
(* A write also has `person_id = :token` in its WHERE (aggregates.ts); the *)
(* rows of the model are the locked person's, so that always holds.        *)
(***************************************************************************)
EXTENDS Sequences

CurrentCode == [
    \* The calls that each command makes, in order (each handler runs in one
    \* transaction, packages/db/src/transactional.ts:41-58). `createAdminGrant` and
    \* `deleteAdminGrant` write admin_grant, not membership: the model takes only
    \* their locks. `deactivateAccount` and `reactivateAccount` (accounts/commands.ts:251-252,
    \* 277-278, through lockAccount at 106-121) take the same two locks.
    \* createMembership reads history and claims welcome_ledger; deleteMembership
    \* also claims it after removal. Both use the existing Person token and take
    \* no new root lock. Ledger and outbox guarantees are tested on PostgreSQL.
    \* syncWorkspace locks generated-address owners in one sorted lockAll;
    \* its one-person case is below, its multi-person and address ordering in Pair and Address.
    compose |-> [
        createMembership   |-> <<"lock", "insert">>,           \* teams/commands.ts:272, 311
        deleteMembership   |-> <<"beginTransition", "remove">>, \* teams/commands.ts:428, 430
        changeMembership   |-> <<"beginTransition", "setEnd", "insert">>, \* teams/commands.ts:183, 193, 200
        endEarlyMembership |-> <<"beginTransition", "setEnd">>, \* teams/commands.ts:447, 449
        extendMembership   |-> <<"beginTransition", "setEnd">>, \* teams/commands.ts:472, 474
        createAdminGrant   |-> <<"lockList", "lock">>,         \* teams/commands.ts:241-242
        deleteAdminGrant   |-> <<"lockList", "lock">>,         \* teams/commands.ts:393, 403
        syncWorkspace      |-> <<"lock">>,                     \* workspace/commands.ts:236, one person
        updatePerson       |-> <<"lock">>                      \* accounts/commands.ts:65, 376
    ],
    \* The statements of each call, in order.
    repo |-> [
        \* beginTransition: the unlocked read that finds the owner, the lock
        \* of that person, the read through its token, on which the machine
        \* decides (teams/commands.ts:118-148).
        beginTransition |-> <<"find", "lockPersonOfRow", "read">>, \* 126, 127, 128, 129-145
        find     |-> <<"find">>,                       \* teams.ts:465-475
        read     |-> <<"read">>,                       \* teams.ts:477-485
        \* AggregateLocks.lock is lockAll of one id: one SELECT ... ORDER BY id
        \* FOR NO KEY UPDATE (db/aggregate/locks.ts:105-111, 136-142). A row
        \* that the transaction holds sends no statement (87-90).
        lock     |-> <<"lockPerson">>,
        \* lockAdminList is lock("AdminList", ADMIN_LIST_ID)
        \* (domain/shared/aggregate.ts:90-91): the same statement on admin_list.
        lockList |-> <<"lockAdminList">>,
        insert   |-> <<"insertRow">>,                  \* teams.ts:558-577, Aggregates.insert
        setEnd   |-> <<"updateEnd">>,                  \* teams.ts:584-614, Aggregates.update
        remove   |-> <<"deleteRow">>                   \* teams.ts:620-649, Aggregates.remove
    ],
    \* A lock that would come before one that the transaction holds is a defect
    \* before any statement is sent (db/aggregate/locks.ts:92-103,
    \* lockScope.ts:36-44). The order: the admin list, then persons by id
    \* (domain/shared/aggregate.ts:36-39).
    orderCheck |-> TRUE,
    \* The WHERE clauses of the conditional writes. A statement that matches no
    \* row is `lostRace`, the typed Conflict (teams.ts:609-613, 644-645).
    setEndWhere |-> {"id", "end=observed", "start<=current", "end>=current"}, \* teams.ts:598-603
    removeWhere |-> {"id", "start=observed", "end=observed", "start>current"}, \* teams.ts:632-640
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

\* The lock without the row lock: the SELECT of AggregateLocks.lock loses its
\* FOR NO KEY UPDATE (locks.ts:110), so every lock, of a person and of the
\* admin list, is a plain read. The state before spec 0006 R6 and mutation M1
\* of spec 0006b R3: two writes of one person overlap, and one of them dies as
\* the victim of a deadlock.
LockTakesNoRowLock ==
    [CurrentCode EXCEPT !.repo = [CurrentCode.repo EXCEPT
        !.beginTransition = <<"find", "read">>, !.lock = <<>>, !.lockList = <<>>]]

\* A command decides on a read before its lock (beginTransition reads with
\* findById, an unlocked read, and locks afterwards). The conditional UPDATE
\* still catches a stale decision, so the code stays legal.
DecideBeforeLock ==
    [CurrentCode EXCEPT !.repo = [CurrentCode.repo EXCEPT
        !.beginTransition = <<"find", "read", "lockPersonOfRow">>]]

\* The decision before the lock, and the UPDATE of setEnd no longer names the
\* end that the command read: two guards removed together.
DecideBeforeLockWithoutObservedEnd ==
    [DecideBeforeLock EXCEPT !.setEndWhere = {"id", "start<=current", "end>=current"}]

\* The decision before the lock, and the UPDATE is only `WHERE id = :id`: the
\* negative control of spec 0006 falsifier 3 as it was before spec 0006b.
DecideBeforeLockUnconditional ==
    [DecideBeforeLock EXCEPT !.setEndWhere = {"id"}]

\* The UPDATE of setEnd is only `WHERE id = :id` and the decision is under the
\* lock: the lock alone keeps every commit legal (spec 0006b R1 item 10, and
\* the control in teams.postgres.test.ts that asserts it).
SetEndUnconditional ==
    [CurrentCode EXCEPT !.setEndWhere = {"id"}]

\* The exclusion constraint is dropped (the negative control of falsifier 4).
NoExclusionConstraint == [CurrentCode EXCEPT !.exclusion = FALSE]

\* The caller is told "already exists" for a deadlock victim too, as if 40P01
\* meant that the other write won. Only visible together with a missing lock.
DeadlockMappedToAlreadyExists == [LockTakesNoRowLock EXCEPT !.on40P01 = "AlreadyExists"]

\* `deleteAdminGrant` locks the holder of the place before the admin list: the order
\* that spec 0006b R2 forbids. The registry refuses it, as a defect, before it
\* sends the second statement.
ListAfterPerson ==
    [CurrentCode EXCEPT !.compose = [CurrentCode.compose EXCEPT
        !.deleteAdminGrant = <<"lock", "lockList">>]]

\* The same order, and the registry does not refuse it (locks.ts:94-103
\* deleted): `createAdminGrant` holds the list and waits for the person, and
\* `deleteAdminGrant` holds the person and waits for the list.
ListAfterPersonUnchecked == [ListAfterPerson EXCEPT !.orderCheck = FALSE]

(***************************************************************************)
(* What-if commands that the code does not have. Not covered code: they    *)
(* show what taking the person's lock first buys.                          *)
(***************************************************************************)

Kinds == {"createMembership", "deleteMembership", "changeMembership",
          "endEarlyMembership", "extendMembership", "createAdminGrant",
          "deleteAdminGrant", "replace"}

\* A command that cancels a planned membership and adds another one in the same
\* transaction, written around the construct: a DELETE with no lock before it
\* (the lint rule `no-owned-table-write` and the token forbid it), then the
\* lock and the INSERT.
ReplaceWritingFirst == [CurrentCode EXCEPT !.compose =
    [k \in Kinds |-> IF k = "replace" THEN <<"find", "read", "remove", "lock", "insert">>
                     ELSE CurrentCode.compose[k]]]

\* The same command written through the construct: it can only call `remove`
\* with the token that its lock returned, so it locks first.
ReplaceThroughConstruct == [CurrentCode EXCEPT !.compose =
    [k \in Kinds |-> IF k = "replace" THEN <<"beginTransition", "remove", "insert">>
                     ELSE CurrentCode.compose[k]]]

(***************************************************************************)
(* Two persons: AggregateLocks.lockAll over two ids. No command calls it   *)
(* with two persons yet (a merge would), so these records are the code of  *)
(* locks.ts and not of a command.                                          *)
(***************************************************************************)

\* lockAll("Person", [a, b]) is one statement, SELECT ... WHERE id IN (a, b)
\* ORDER BY id FOR NO KEY UPDATE (locks.ts:105-111). PostgreSQL takes the rows
\* one at a time in ORDER BY order, and a row that another transaction holds
\* makes the statement wait while the rows before it stay locked: two
\* acquisitions, the lower id first, whatever the order of the arguments
\* (pinned in membershipWriteModel.postgres.test.ts).
LockAll == [CurrentCode EXCEPT
    !.repo = [lower |-> <<"lockLowerPerson">>, higher |-> <<"lockHigherPerson">>],
    !.compose = [lockBoth |-> <<"lower", "higher">>]]

\* The two locks one after the other in the order that the caller names the
\* persons, written as SQL outside the registry: the negative control of
\* aggregates.postgres.test.ts, falsifier 2.
LocksInCallOrder == [CurrentCode EXCEPT
    !.orderCheck = FALSE,
    !.repo = [first |-> <<"lockPerson">>, second |-> <<"lockSecondPerson">>],
    !.compose = [lockBoth |-> <<"first", "second">>]]

\* The same two calls through AggregateLocks.lock: the registry refuses the one
\* that comes after a higher id (aggregates.postgres.test.ts, "a lock that would
\* break the global order is a defect").
LocksInCallOrderThroughRegistry == [LocksInCallOrder EXCEPT !.orderCheck = TRUE]

=============================================================================
