------------------------------ MODULE JobRuns ------------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, MaxAttempts, Chunks, Variant
VARIABLES outcome, attempt, held, valid, phase, cursor, seen, expired, live, report,
          staleWrite, terminalChanged, badReport, endedAt
vars == <<outcome, attempt, held, valid, phase, cursor, seen, expired, live, report,
          staleWrite, terminalChanged, badReport, endedAt>>
Terminal == {"done", "failed"}
Unbounded == Variant \in {"unbounded", "legacy"}
FalseReports == Variant \in {"reports", "legacy"}
MissingCheck == Variant \in {"check", "legacy"}
Owns(w) == outcome = "running" /\ valid[w]
Eligible == outcome \in {"new", "partial", "running"}
            /\ (outcome # "running" \/ expired \/ Variant = "holders")
Init ==
 /\ outcome = "new" /\ attempt = 0 /\ cursor = 0 /\ endedAt = FALSE
 /\ held = [w \in Workers |-> 0] /\ valid = [w \in Workers |-> FALSE]
 /\ phase = [w \in Workers |-> "idle"]
 /\ report = [w \in Workers |-> "none"]
 /\ seen = [c \in 0..(Chunks-1) |-> 0]
 /\ expired = TRUE /\ live = {} /\ staleWrite = FALSE /\ terminalChanged = FALSE
 /\ badReport = FALSE

Claim(w) ==
 /\ phase[w] = "idle" /\ Eligible
 /\ IF attempt >= MaxAttempts /\ ~Unbounded
     THEN /\ outcome' = "failed" /\ endedAt' = TRUE /\ live' = {} /\ expired' = TRUE
          /\ valid' = [x \in Workers |-> FALSE]
          /\ UNCHANGED <<attempt, held, phase>>
     ELSE /\ outcome' = "running" /\ endedAt' = FALSE
          /\ attempt' = IF attempt < MaxAttempts THEN attempt + 1 ELSE attempt
          /\ held' = [held EXCEPT ![w] = attempt']
          /\ valid' = [x \in Workers |-> x = w]
          /\ phase' = [phase EXCEPT ![w] = "work"]
          /\ live' = IF Variant = "holders" THEN live \cup {w} ELSE {w}
          /\ expired' = FALSE
 /\ UNCHANGED <<cursor, seen, report, staleWrite, terminalChanged, badReport>>

Expire == /\ outcome = "running" /\ ~expired
 /\ expired' = TRUE /\ live' = {}
 /\ UNCHANGED <<outcome, attempt, held, valid, phase, cursor, seen, report,
                 staleWrite, terminalChanged, badReport, endedAt>>
Crash(w) == /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"] /\ live' = live \ {w}
 /\ UNCHANGED <<outcome, attempt, held, valid, cursor, seen, expired, report,
                 staleWrite, terminalChanged, badReport, endedAt>>

Commit(w) ==
 /\ phase[w] = "work" /\ cursor < Chunks
 /\ (Owns(w) \/ Variant = "fence")
 /\ staleWrite' = (staleWrite \/ ~Owns(w))
 /\ seen' = [seen EXCEPT ![cursor] = @ + 1]
 /\ cursor' = IF Variant = "atomic" THEN cursor ELSE cursor + 1
 /\ outcome' = IF cursor = Chunks - 1 THEN "done" ELSE outcome
 /\ endedAt' = IF cursor = Chunks - 1 THEN TRUE ELSE endedAt
 /\ terminalChanged' = (terminalChanged \/ outcome \in Terminal)
 /\ phase' = IF cursor = Chunks - 1 THEN [phase EXCEPT ![w] = "idle"] ELSE phase
 /\ live' = IF cursor = Chunks - 1 THEN {} ELSE live
 /\ expired' = IF cursor = Chunks - 1 THEN TRUE ELSE FALSE
 /\ UNCHANGED <<attempt, held, valid, report, badReport>>

Release(w) ==
 /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"]
 /\ report' = [report EXCEPT ![w] = IF Owns(w) \/ FalseReports THEN "partial" ELSE "lost"]
 /\ badReport' = (badReport \/ (~Owns(w) /\ FalseReports))
 /\ outcome' = IF Owns(w) THEN "partial" ELSE outcome
 /\ live' = IF Owns(w) THEN {} ELSE live
 /\ expired' = IF Owns(w) THEN TRUE ELSE expired
 /\ UNCHANGED <<attempt, held, valid, cursor, seen, staleWrite, terminalChanged, endedAt>>

Fail(w) ==
 /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"]
 /\ report' = [report EXCEPT ![w] = IF ~Owns(w) /\ ~FalseReports THEN "lost"
                                   ELSE IF held[w] >= MaxAttempts THEN "failed" ELSE "retry"]
 /\ badReport' = (badReport \/ (~Owns(w) /\ FalseReports))
 /\ outcome' = IF Owns(w) THEN IF held[w] >= MaxAttempts THEN "failed" ELSE "partial" ELSE outcome
 /\ endedAt' = IF Owns(w) THEN held[w] >= MaxAttempts ELSE endedAt
 /\ live' = IF Owns(w) THEN {} ELSE live
 /\ expired' = IF Owns(w) THEN TRUE ELSE expired
 /\ UNCHANGED <<attempt, held, valid, cursor, seen, staleWrite, terminalChanged>>

Reopen == /\ Variant = "terminal" /\ outcome \in Terminal
 /\ outcome' = "partial" /\ terminalChanged' = TRUE
 /\ UNCHANGED <<attempt, held, valid, phase, cursor, seen, expired, live, report,
                 staleWrite, badReport, endedAt>>
\* An arbitrary writer, not the repository: the fixed CHECK refuses this write.
StoreDoneWithoutEnd == /\ MissingCheck /\ outcome \notin Terminal
 /\ outcome' = "done" /\ endedAt' = FALSE
 /\ UNCHANGED <<attempt, held, valid, phase, cursor, seen, expired, live, report,
                 staleWrite, terminalChanged, badReport>>
Next == (\E w \in Workers: Claim(w) \/ Crash(w) \/ Commit(w) \/ Release(w) \/ Fail(w))
        \/ Expire \/ Reopen \/ StoreDoneWithoutEnd
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Expire) /\ SF_vars(\E w \in Workers: Claim(w))
            /\ WF_vars(\E w \in Workers: Crash(w) \/ Release(w) \/ Fail(w) \/ Commit(w))
CrashNext == (\E w \in Workers: Claim(w) \/ Crash(w)) \/ Expire
CrashSpec == Init /\ [][CrashNext]_vars /\ WF_vars(Expire)
             /\ SF_vars(\E w \in Workers: Claim(w)) /\ WF_vars(\E w \in Workers: Crash(w))
ProgressSpec == FairSpec /\ SF_vars(\E w \in Workers: Commit(w) /\ Owns(w))
NoTwoLive == Cardinality(live) <= 1
NoStaleWrite == ~staleWrite
AtMostOnce == \A c \in 0..(Chunks-1): seen[c] <= 1
TerminalStable == ~terminalChanged
HonestReports == ~badReport
DoneHasEnd == outcome = "done" => endedAt
EventuallyTerminal == <> (outcome \in Terminal)
=============================================================================
