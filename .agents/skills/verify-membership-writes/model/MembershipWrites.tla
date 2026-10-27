---------------------------- MODULE MembershipWrites ----------------------------
(***************************************************************************)
(* Several commands write one person's memberships at the same time, each  *)
(* in its own PostgreSQL transaction (READ COMMITTED, the default; probes  *)
(* confirm it on PostgreSQL 18). What can go wrong depends on which locks  *)
(* the code takes, in which order, and on how PostgreSQL checks the        *)
(* exclusion constraint `membership_no_overlap`.                           *)
(*                                                                         *)
(* This module has two kinds of definitions:                               *)
(*   - what the CODE does: the record `Code`, defined in Shapes.tla, with  *)
(*     the statements of each call that a command makes and of each        *)
(*     command, with the file and line of each. Change the code, change    *)
(*     that record.                                                        *)
(*   - what POSTGRESQL does: everything below. Each action is one step     *)
(*     that another transaction can interleave with; the probes in         *)
(*     packages/db/test/membershipWriteModel.postgres.test.ts show each of *)
(*     them on a real database.                                            *)
(*                                                                         *)
(* A transaction runs one command. The command is a list of statements    *)
(* (`Steps`). Since spec 0006b a command takes its lock first, with        *)
(* `AggregateLocks` (`SELECT ... ORDER BY id FOR NO KEY UPDATE` on the     *)
(* person's row, or on the admin list's one row), reads what it decides    *)
(* on after the lock, and writes through the lock's token. Two statements  *)
(* are split in two steps because PostgreSQL lets other transactions in    *)
(* between: an INSERT, and an UPDATE that moves the term, first write the  *)
(* new row and its index entry and only then check the exclusion           *)
(* constraint against every other entry, including entries of              *)
(* transactions that have not finished (`CheckWait`, `CheckRefuse`,        *)
(* `CheckPass`).                                                           *)
(*                                                                         *)
(* The locks have one global order: the admin list, then persons in        *)
(* ascending id. The code refuses a lock that would come before one that   *)
(* the transaction holds (`LockOrderViolation`: a defect, and no statement *)
(* is sent), so a command never waits for a lock while it holds a later    *)
(* one (`AcquireLock`).                                                    *)
(*                                                                         *)
(* Abstractions (argued in SKILL.md, "What is verified, and what is not"): *)
(*   - an UPDATE is one step: the row lock, the new version and its index  *)
(*     entry together. Inside PostgreSQL other transactions can see the    *)
(*     old row locked before the new one has its entry; every outcome that *)
(*     allows is reachable by another order of this model's steps.         *)
(*   - the current semester does not change during a race.                 *)
(*   - foreign-key checks, the audit row, the outbox rows and the rows of  *)
(*     the other tables that a person owns (admin_grant, account, code)    *)
(*     are left out: their commands appear only as the locks they take.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Txns,       \* the commands that run at the same time, one transaction each
    NoTxn,      \* nobody: a free lock, a row nobody deleted, nobody to wait for
    Genesis,    \* the creator of the rows that exist before the race starts
    NoRow,      \* the row of a command that targets no existing row
    Persons,
    InitRows,   \* the memberships that exist when the race starts
    Plans,      \* the commands that a transaction may run, with their inputs
    Current,    \* the current semester (a number), fixed during the race
    Code        \* the shape of the code, from Shapes.tla

VARIABLES
    plan,       \* plan[t]: the command that t runs
    pc,         \* pc[t]: the position of t's next statement in its command
    status,     \* status[t]: "running", "committed" or "aborted"
    outcome,    \* outcome[t]: what the command's caller is told
    err,        \* err[t]: the SQLSTATE that ended t, or "none"
    blocked,    \* blocked[t]: the transaction that t waits for, or NoTxn
    holder,     \* holder[k]: the transaction that holds the row lock of key k: a person, or the admin list
    versions,   \* every version of every membership row, as PostgreSQL keeps them
    seen,       \* seen[t]: the term that t read before its conditional write
    pending,    \* pending[t]: {the row version that t wrote and has not checked yet}
    replaced,   \* replaced[t]: {the term that t's update replaced}
    backed      \* backed[t]: at the end of t, was there a committed overlapping row?

vars == << plan, pc, status, outcome, err, blocked, holder, versions, seen,
           pending, replaced, backed >>

\* The admin list's one row is a lock key of its own. It comes before every
\* person (shared/aggregate.ts, AggregateRoots), and persons are 1, 2, ..., so
\* the keys sort in lock order.
AdminList == 0
LockKeys == Persons \cup {AdminList}

(***************************************************************************)
(* The command and its statements                                         *)
(***************************************************************************)

RECURSIVE Flatten(_)
Flatten(seqs) == IF seqs = <<>> THEN <<>> ELSE Head(seqs) \o Flatten(Tail(seqs))

\* The statements of a command: the statements of each repository method that
\* the command calls, in call order (Shapes.tla, `compose` and `repo`).
Steps(kind) ==
    LET calls == Code.compose[kind]
    IN  Flatten([i \in 1..Len(calls) |-> Code.repo[calls[i]]])

Program(t) == Steps(plan[t].kind)

Running(t) == status[t] = "running"
Free(t) == Running(t) /\ blocked[t] = NoTxn

\* t is free, owes no constraint check, and its next statement is `op`.
At(t, op) ==
    /\ Free(t)
    /\ pending[t] = {}
    /\ pc[t] <= Len(Program(t))
    /\ Program(t)[pc[t]] = op

\* The statement is done: on to the next one.
Advance(t) == pc' = [pc EXCEPT ![t] = @ + 1]

(***************************************************************************)
(* What PostgreSQL sees: versions, visibility, who to wait for             *)
(***************************************************************************)

Committed(x) == x = Genesis \/ (x \in Txns /\ status[x] = "committed")
Aborted(x) == x \in Txns /\ status[x] = "aborted"

Overlap(a, b) == a.s <= b.e /\ b.s <= a.e     \* int4range(start, end, '[]') &&

\* Gone for t: its creator rolled back, or t or a committed transaction deleted it.
Gone(v, t) ==
    \/ Aborted(v.creator)
    \/ v.deleter = t
    \/ (v.deleter \in Txns /\ status[v.deleter] = "committed")

\* The transaction that t must wait for before it can judge row version v: the
\* one that is still inserting it, else the one that is still deleting it.
Awaited(v, t) ==
    IF v.creator \in Txns /\ v.creator /= t /\ status[v.creator] = "running"
        THEN v.creator
    ELSE IF v.deleter \in Txns /\ v.deleter /= t /\ status[v.deleter] = "running"
        THEN v.deleter
    ELSE NoTxn

\* The version of `row` that a statement of t finds: made by a committed
\* transaction (or by t), and not deleted by a committed transaction (or by t).
\* A row that another transaction is still changing is found, and waited for.
Found(row, t) ==
    { v \in versions :
        /\ v.id = row
        /\ (Committed(v.creator) \/ v.creator = t)
        /\ ~(v.deleter = t)
        /\ ~(v.deleter \in Txns /\ status[v.deleter] = "committed") }

BeingChanged(v, t) ==
    /\ v.deleter \in Txns
    /\ v.deleter /= t
    /\ status[v.deleter] = "running"

RowPerson(row) == (CHOOSE r \in InitRows : r.id = row).person

\* The term of a version, as a command reads it.
TermOf(v) == [person |-> v.person, team |-> v.team, s |-> v.s, e |-> v.e]

(***************************************************************************)
(* How a transaction ends                                                  *)
(***************************************************************************)

\* Was there a committed row (or one of t's own) that overlaps what t tried to write?
BackedBy(t) ==
    \E nv \in pending[t] :
        \E v \in versions :
            /\ v /= nv
            /\ (Committed(v.creator) \/ v.creator = t)
            /\ ~(v.deleter \in Txns /\ status[v.deleter] = "committed")
            /\ v.person = nv.person /\ v.team = nv.team /\ Overlap(v, nv)

\* t's transaction ends. Its locks go; its rows commit or die with its status.
Finish(t, st, told, sqlstate) ==
    /\ status' = [status EXCEPT ![t] = st]
    /\ outcome' = [outcome EXCEPT ![t] = told]
    /\ err' = [err EXCEPT ![t] = sqlstate]
    /\ holder' = [k \in LockKeys |-> IF holder[k] = t THEN NoTxn ELSE holder[k]]
    /\ pending' = [pending EXCEPT ![t] = {}]
    /\ blocked' = [blocked EXCEPT ![t] = NoTxn]
    /\ backed' = [backed EXCEPT ![t] = BackedBy(t)]

\* A request is cancelled: the program is interrupted and the transaction rolls
\* back (AGENTS.md: `enable_request_signal`). It can happen at any moment.
Cancel(t) ==
    /\ Running(t)
    /\ Finish(t, "aborted", "cancelled", "none")
    /\ UNCHANGED << plan, pc, versions, seen, replaced >>

\* The command is done: COMMIT.
Commit(t) ==
    /\ Free(t)
    /\ pending[t] = {}
    /\ pc[t] > Len(Program(t))
    /\ Finish(t, "committed", "committed", "none")
    /\ UNCHANGED << plan, pc, versions, seen, replaced >>

\* A statement finds nothing to change, or the machine refuses: a typed
\* refusal, and the transaction rolls back.
Refuse(t, told) ==
    /\ Finish(t, "aborted", told, "none")
    /\ UNCHANGED << plan, pc, versions, seen, replaced >>

(***************************************************************************)
(* Waiting, and the deadlock detector                                      *)
(***************************************************************************)

\* The transaction that t waits for ended: t looks again.
Wake(t) ==
    /\ Running(t)
    /\ blocked[t] /= NoTxn
    /\ status[blocked[t]] /= "running"
    /\ blocked' = [blocked EXCEPT ![t] = NoTxn]
    /\ UNCHANGED << plan, pc, status, outcome, err, holder, versions, seen,
                    pending, replaced, backed >>

Successor(x) == IF x = NoTxn THEN NoTxn ELSE blocked[x]
RECURSIVE Hop(_, _)
Hop(x, n) == IF n = 0 THEN x ELSE Hop(Successor(x), n - 1)
InCycle(t) == \E n \in 1..Cardinality(Txns) : Hop(t, n) = t

\* PostgreSQL finds a cycle of waits (after `deadlock_timeout`) and rolls back
\* one transaction of the cycle with SQLSTATE 40P01. Which one is not defined.
\* What the caller is told is the code's mapping of that SQLSTATE
\* (classifySqlFailure.ts: a defect).
Deadlock(t) ==
    /\ Running(t)
    /\ InCycle(t)
    /\ Finish(t, "aborted", Code.on40P01, "40P01")
    /\ UNCHANGED << plan, pc, versions, seen, replaced >>

(***************************************************************************)
(* Statements                                                              *)
(***************************************************************************)

\* A command reads the membership it is about (`findLocked`, a plain SELECT
\* through the lock's token) and its machine decides (commands.ts, beginTransition).
StateOf(term) ==
    IF Current < term.s THEN "Planned"
    ELSE IF Current <= term.e THEN "Active"
    ELSE "Ended"

NewEnd(pl) == IF pl.kind = "extend" THEN pl.e ELSE pl.from - 1

\* declaration.ts MembershipMachine: the transitions and their guards.
Allowed(pl, term) ==
    CASE pl.kind = "extend"
            -> StateOf(term) = "Active" /\ pl.e > term.e
      [] pl.kind \in {"endEarly", "change"}
            -> StateOf(term) = "Active" /\ term.s < pl.from /\ pl.from <= term.e
               /\ Current <= pl.from
      [] pl.kind \in {"cancel", "replace"}
            -> StateOf(term) = "Planned"

\* MembershipRepository.findById: a plain SELECT without a lock. It finds whose
\* lock the command takes next (the owner of a membership never changes), and
\* ends the command when no committed row is there.
FindRow(t) ==
    /\ At(t, "find")
    /\ LET rows == Found(plan[t].row, t)
       IN  \/ /\ rows = {}
              /\ Refuse(t, "NotFound")
           \/ /\ rows /= {}
              /\ Advance(t)
              /\ UNCHANGED << plan, status, outcome, err, blocked, holder,
                              versions, seen, pending, replaced, backed >>

ReadRow(t) ==
    /\ At(t, "read")
    /\ LET rows == Found(plan[t].row, t)
       IN  \/ /\ rows = {}
              /\ Refuse(t, "NotFound")
           \/ \E v \in rows :
                 /\ seen' = [seen EXCEPT ![t] = TermOf(v)]
                 /\ \/ /\ Allowed(plan[t], TermOf(v))
                       /\ Advance(t)
                       /\ UNCHANGED << plan, status, outcome, err, blocked, holder,
                                       versions, pending, replaced, backed >>
                    \/ /\ ~Allowed(plan[t], TermOf(v))
                       /\ Finish(t, "aborted", "Conflict", "none")
                       /\ UNCHANGED << plan, pc, versions, replaced >>

LockedKey(t, op) ==
    CASE op = "lockPerson"        -> plan[t].person
      [] op = "lockPersonOfRow"   -> RowPerson(plan[t].row)
      [] op = "lockAdminList"     -> AdminList
      [] op = "lockSecondPerson"  -> plan[t].person2
      [] op = "lockLowerPerson"   -> IF plan[t].person <= plan[t].person2
                                        THEN plan[t].person ELSE plan[t].person2
      [] op = "lockHigherPerson"  -> IF plan[t].person <= plan[t].person2
                                        THEN plan[t].person2 ELSE plan[t].person

LockOps == { "lockPerson", "lockPersonOfRow", "lockAdminList", "lockSecondPerson",
             "lockLowerPerson", "lockHigherPerson" }

\* A lock that would come before one that t holds (lockScope.ts, orderViolation).
\* A row that t holds is not locked again.
OutOfOrder(t, k) == /\ holder[k] /= t /\ \E q \in LockKeys : holder[q] = t /\ q > k

\* SELECT ... ORDER BY id FOR NO KEY UPDATE on one row (AggregateLocks.lock). It
\* waits while another transaction holds the row, and holds it until the
\* transaction ends. A lock out of order is refused before the statement is sent.
AcquireLock(t) ==
    \E op \in LockOps :
        /\ At(t, op)
        /\ LET k == LockedKey(t, op)
           IN  \/ /\ Code.orderCheck /\ OutOfOrder(t, k)
                  /\ Refuse(t, "LockOrderViolation")
               \/ /\ ~(Code.orderCheck /\ OutOfOrder(t, k))
                  /\ holder[k] \in {NoTxn, t}
                  /\ holder' = [holder EXCEPT ![k] = t]
                  /\ Advance(t)
                  /\ UNCHANGED << plan, status, outcome, err, blocked, versions,
                                  seen, pending, replaced, backed >>
               \/ /\ ~(Code.orderCheck /\ OutOfOrder(t, k))
                  /\ ~(holder[k] \in {NoTxn, t})
                  /\ blocked' = [blocked EXCEPT ![t] = holder[k]]
                  /\ UNCHANGED << plan, pc, status, outcome, err, holder, versions,
                                  seen, pending, replaced, backed >>

\* The membership that an INSERT writes: a command's own input, or for `change`
\* the rest of the term of the membership that it ends (teams/commands.ts:275-281).
InsertedTerm(t) ==
    IF plan[t].kind = "change"
        THEN [team |-> plan[t].team2, s |-> plan[t].from, e |-> seen[t].e]
        ELSE [team |-> plan[t].team, s |-> plan[t].s, e |-> plan[t].e]

\* INSERT, first half: the row and its index entry are written. Another
\* transaction that checks the constraint now sees them.
InsertRow(t) ==
    /\ At(t, "insertRow")
    /\ LET term == InsertedTerm(t)
           nv == [id |-> t, person |-> plan[t].person, team |-> term.team,
                  s |-> term.s, e |-> term.e, creator |-> t, deleter |-> NoTxn]
       IN  /\ versions' = versions \cup {nv}
           /\ pending' = [pending EXCEPT ![t] = {nv}]
    /\ UNCHANGED << plan, pc, status, outcome, err, blocked, holder, seen,
                    replaced, backed >>

\* The conditions of a statement's WHERE clause, on the row version it found.
Condition(c, v, t) ==
    CASE c = "id"              -> TRUE
      [] c = "end=observed"    -> v.e = seen[t].e
      [] c = "start=observed"  -> v.s = seen[t].s
      [] c = "start<=current"  -> v.s <= Current
      [] c = "end>=current"    -> v.e >= Current
      [] c = "start>current"   -> v.s > Current

Holds(conditions, v, t) == \A c \in conditions : Condition(c, v, t)

\* UPDATE membership SET end = ... WHERE <Code.setEndWhere>: a row that another
\* transaction is changing is waited for; a row that no longer matches after
\* the wait (PostgreSQL looks at the newest version) is zero rows, which the
\* code reports as a lost race.
UpdateEnd(t) ==
    /\ At(t, "updateEnd")
    /\ LET rows == Found(plan[t].row, t)
       IN  \/ /\ rows = {}
              /\ Refuse(t, "Conflict")
           \/ \E v \in rows :
                 \/ /\ BeingChanged(v, t)
                    /\ blocked' = [blocked EXCEPT ![t] = v.deleter]
                    /\ UNCHANGED << plan, pc, status, outcome, err, holder, versions,
                                    seen, pending, replaced, backed >>
                 \/ /\ ~BeingChanged(v, t)
                    /\ ~Holds(Code.setEndWhere, v, t)
                    /\ Refuse(t, "Conflict")
                 \/ /\ ~BeingChanged(v, t)
                    /\ Holds(Code.setEndWhere, v, t)
                    /\ LET nv == [v EXCEPT !.e = NewEnd(plan[t]), !.creator = t,
                                            !.deleter = NoTxn]
                       IN  /\ versions' = (versions \ {v}) \cup {[v EXCEPT !.deleter = t], nv}
                           /\ pending' = [pending EXCEPT ![t] = {nv}]
                    /\ replaced' = [replaced EXCEPT ![t] = {[s |-> v.s, e |-> v.e]}]
                    /\ UNCHANGED << plan, pc, status, outcome, err, blocked, holder,
                                    seen, backed >>

\* DELETE FROM membership WHERE <Code.removeWhere>.
DeleteRow(t) ==
    /\ At(t, "deleteRow")
    /\ LET rows == Found(plan[t].row, t)
       IN  \/ /\ rows = {}
              /\ Refuse(t, "Conflict")
           \/ \E v \in rows :
                 \/ /\ BeingChanged(v, t)
                    /\ blocked' = [blocked EXCEPT ![t] = v.deleter]
                    /\ UNCHANGED << plan, pc, status, outcome, err, holder, versions,
                                    seen, pending, replaced, backed >>
                 \/ /\ ~BeingChanged(v, t)
                    /\ ~Holds(Code.removeWhere, v, t)
                    /\ Refuse(t, "Conflict")
                 \/ /\ ~BeingChanged(v, t)
                    /\ Holds(Code.removeWhere, v, t)
                    /\ versions' = (versions \ {v}) \cup {[v EXCEPT !.deleter = t]}
                    /\ Advance(t)
                    /\ UNCHANGED << plan, status, outcome, err, blocked, holder,
                                    seen, pending, replaced, backed >>

(***************************************************************************)
(* The exclusion constraint, second half of INSERT and of a term-changing  *)
(* UPDATE: PostgreSQL looks through the index for entries that overlap the *)
(* new one (including entries of unfinished transactions). It takes them   *)
(* in index order, and the first one decides: wait for the unfinished      *)
(* transaction that wrote or deleted it, or refuse (23P01) because it is   *)
(* committed. After a wait it starts again.                                *)
(***************************************************************************)

Rivals(t, nv) ==
    IF ~Code.exclusion THEN {}
    ELSE { v \in versions :
             /\ v /= nv
             /\ v.person = nv.person /\ v.team = nv.team
             /\ Overlap(v, nv)
             /\ ~Gone(v, t) }

CheckWait(t) ==
    /\ Free(t)
    /\ \E nv \in pending[t] :
         \E v \in Rivals(t, nv) :
             /\ Awaited(v, t) /= NoTxn
             /\ blocked' = [blocked EXCEPT ![t] = Awaited(v, t)]
    /\ UNCHANGED << plan, pc, status, outcome, err, holder, versions, seen,
                    pending, replaced, backed >>

CheckRefuse(t) ==
    /\ Free(t)
    /\ \E nv \in pending[t] :
         \E v \in Rivals(t, nv) : Awaited(v, t) = NoTxn
    /\ Finish(t, "aborted", Code.on23P01, "23P01")
    /\ UNCHANGED << plan, pc, versions, seen, replaced >>

CheckPass(t) ==
    /\ Free(t)
    /\ \E nv \in pending[t] : Rivals(t, nv) = {}
    /\ pending' = [pending EXCEPT ![t] = {}]
    /\ Advance(t)
    /\ UNCHANGED << plan, status, outcome, err, blocked, holder, versions, seen,
                    replaced, backed >>

(***************************************************************************)
(* The whole model                                                         *)
(***************************************************************************)

Init ==
    /\ plan \in [Txns -> Plans]
    /\ pc = [t \in Txns |-> 1]
    /\ status = [t \in Txns |-> "running"]
    /\ outcome = [t \in Txns |-> "running"]
    /\ err = [t \in Txns |-> "none"]
    /\ blocked = [t \in Txns |-> NoTxn]
    /\ holder = [k \in LockKeys |-> NoTxn]
    /\ versions = { [id |-> r.id, person |-> r.person, team |-> r.team,
                     s |-> r.s, e |-> r.e, creator |-> Genesis, deleter |-> NoTxn]
                    : r \in InitRows }
    /\ seen = [t \in Txns |-> [person |-> 0, team |-> "-", s |-> 0, e |-> 0]]
    /\ pending = [t \in Txns |-> {}]
    /\ replaced = [t \in Txns |-> {}]
    /\ backed = [t \in Txns |-> FALSE]

Done == \A t \in Txns : status[t] /= "running"

\* Every transaction has ended: nothing more happens.
Finished == Done /\ UNCHANGED vars

Next ==
    \/ \E t \in Txns :
         \/ FindRow(t) \/ ReadRow(t) \/ AcquireLock(t) \/ InsertRow(t) \/ UpdateEnd(t)
         \/ DeleteRow(t) \/ CheckWait(t) \/ CheckRefuse(t) \/ CheckPass(t)
         \/ Commit(t) \/ Cancel(t) \/ Wake(t) \/ Deadlock(t)
    \/ Finished

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* The properties                                                          *)
(***************************************************************************)

TypeOK ==
    /\ \A t \in Txns : status[t] \in {"running", "committed", "aborted"}
    /\ \A t \in Txns : err[t] \in {"none", "23P01", "40P01"}
    /\ \A t \in Txns : blocked[t] \in Txns \cup {NoTxn}
    /\ \A k \in LockKeys : holder[k] \in Txns \cup {NoTxn}
    /\ \A t \in Txns : Cardinality(pending[t]) <= 1 /\ Cardinality(replaced[t]) <= 1

\* Rule (spec 0006 R6): a membership write is never rolled back as a deadlock
\* victim. 40P01 says nothing about the data (the other transaction can still
\* roll back), so the code leaves it a defect and answers the caller with an
\* error that nobody can act on.
NoDeadlockAbort == \A t \in Txns : err[t] /= "40P01"

\* Rule (spec 0006 falsifier 4): two committed memberships of one person in one
\* team never overlap, whatever the order of the writes and the rollbacks.
Standing(v) ==
    /\ Committed(v.creator)
    /\ ~(v.deleter \in Txns /\ status[v.deleter] = "committed")

NoOverlapCommitted ==
    \A v, w \in versions :
        (v /= w /\ Standing(v) /\ Standing(w) /\ v.person = w.person /\ v.team = w.team)
            => ~Overlap(v, w)

\* Rule (spec 0006 R6): "AlreadyExists" is a verdict on the data. Whenever a
\* caller is told that the membership exists, a committed membership that
\* overlaps the one it tried to write existed when its transaction ended.
RefusalsAreTrue == \A t \in Txns : outcome[t] = "AlreadyExists" => backed[t]

\* Rule (spec 0006 falsifier 3): a transition that commits was legal from the
\* term it actually replaced, not only from the term its command read earlier.
LegalAtApply ==
    \A t \in Txns : status[t] = "committed" => \A r \in replaced[t] : Allowed(plan[t], r)

\* Rule (spec 0006b contract 1): the writes of one person never run at the same
\* time, because each one takes the person's lock first. So no write ever waits
\* inside the exclusion check for another transaction's unfinished row.
NoWaitInCheck == \A t \in Txns : ~(blocked[t] /= NoTxn /\ pending[t] /= {})

(***************************************************************************)
(* Goals. A pass means little if the model cannot do the things that the   *)
(* properties are about. Each goal says "this never happens"; run.sh       *)
(* expects TLC to break it (the `reach-` runs), and the path that breaks   *)
(* it is a way to the goal.                                                *)
(***************************************************************************)

\* The loser of an overlap race is told that the membership exists.
NeverAlreadyExists == \A t \in Txns : outcome[t] /= "AlreadyExists"

\* A command loses the race on its own membership and is told that it changed.
NeverConflict == \A t \in Txns : outcome[t] /= "Conflict"

\* A write waits for the person's row lock.
NeverWaitsForLock ==
    \A t \in Txns :
        ~(/\ blocked[t] /= NoTxn
          /\ pending[t] = {}
          /\ pc[t] <= Len(Program(t))
          /\ Program(t)[pc[t]] \in LockOps)

\* A command waits for the admin list's lock.
NeverWaitsForList ==
    \A t \in Txns :
        ~(/\ blocked[t] /= NoTxn
          /\ pending[t] = {}
          /\ pc[t] <= Len(Program(t))
          /\ Program(t)[pc[t]] = "lockAdminList")

\* A command waits for a person's lock while it holds the admin list's lock:
\* the case that the global order of the locks is for.
NeverWaitsForPersonHoldingList ==
    \A t \in Txns :
        ~(/\ blocked[t] /= NoTxn
          /\ holder[AdminList] = t
          /\ pending[t] = {}
          /\ pc[t] <= Len(Program(t))
          /\ Program(t)[pc[t]] \in LockOps \ {"lockAdminList"})

\* A lock out of order is refused as a defect.
NeverOrderViolation == \A t \in Txns : outcome[t] /= "LockOrderViolation"

\* A `change` commits: it ends one membership and starts another in one transaction.
NeverChangeCommits == \A t \in Txns : ~(plan[t].kind = "change" /\ status[t] = "committed")

\* Every command commits, none refused and none cancelled.
NeverAllCommit == ~(\A t \in Txns : status[t] = "committed")

=============================================================================
