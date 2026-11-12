------------------------------ MODULE JobRuns ------------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, MaxAttempts, Chunks, Variant
VARIABLES outcome, attempt, held, valid, phase, cursor, seen, expired, live, report,
          staleWrite, terminalChanged
vars == <<outcome, attempt, held, valid, phase, cursor, seen, expired, live, report,
          staleWrite, terminalChanged>>
Terminal == {"done", "failed"}
Init ==
 /\ outcome = "new" /\ attempt = 0 /\ cursor = 0
 /\ held = [w \in Workers |-> 0] /\ valid = [w \in Workers |-> FALSE]
 /\ phase = [w \in Workers |-> "idle"]
 /\ report = [w \in Workers |-> "none"]
 /\ seen = [c \in 0..(Chunks-1) |-> 0]
 /\ expired = TRUE /\ live = {} /\ staleWrite = FALSE /\ terminalChanged = FALSE

Claim(w) ==
 /\ phase[w] = "idle"
 /\ outcome \in {"new", "partial", "running"}
 /\ (outcome # "running" \/ expired \/ Variant = "holders")
 /\ outcome' = "running" /\ attempt' = IF attempt < MaxAttempts THEN attempt + 1 ELSE attempt
 /\ held' = [held EXCEPT ![w] = attempt']
 /\ valid' = [x \in Workers |-> x = w]
 /\ phase' = [phase EXCEPT ![w] = "work"]
 /\ live' = IF Variant = "holders" THEN live \cup {w} ELSE {w}
 /\ expired' = FALSE
 /\ UNCHANGED <<cursor, seen, report, staleWrite, terminalChanged>>

Expire == /\ outcome = "running" /\ ~expired
          /\ expired' = TRUE /\ live' = {}
          /\ UNCHANGED <<outcome, attempt, held, valid, phase, cursor, seen, report, staleWrite, terminalChanged>>
Crash(w) == /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"] /\ live' = live \ {w}
 /\ UNCHANGED <<outcome, attempt, held, valid, cursor, seen, expired, report, staleWrite, terminalChanged>>

Commit(w) ==
 /\ phase[w] = "work" /\ cursor < Chunks
 /\ ((outcome = "running" /\ valid[w]) \/ Variant = "fence")
 /\ staleWrite' = (staleWrite \/ ~valid[w] \/ outcome # "running")
 /\ seen' = [seen EXCEPT ![cursor] = @ + 1]
 /\ cursor' = IF Variant = "atomic" THEN cursor ELSE cursor + 1
 /\ outcome' = IF cursor = Chunks - 1 THEN "done" ELSE outcome
 /\ terminalChanged' = (terminalChanged \/ outcome \in Terminal)
 /\ phase' = IF cursor = Chunks - 1 THEN [phase EXCEPT ![w] = "idle"] ELSE phase
 /\ live' = IF cursor = Chunks - 1 THEN {} ELSE live
 /\ expired' = IF cursor = Chunks - 1 THEN TRUE ELSE FALSE
 /\ UNCHANGED <<attempt, held, valid, report>>

Release(w) ==
 /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"]
 /\ report' = [report EXCEPT ![w] = "partial"]
 /\ outcome' = IF outcome = "running" /\ valid[w] THEN "partial" ELSE outcome
 /\ live' = IF outcome = "running" /\ valid[w] THEN {} ELSE live
 /\ expired' = IF outcome = "running" /\ valid[w] THEN TRUE ELSE expired
 /\ UNCHANGED <<attempt, held, valid, cursor, seen, staleWrite, terminalChanged>>

Fail(w) ==
 /\ phase[w] = "work"
 /\ phase' = [phase EXCEPT ![w] = "idle"]
 /\ report' = [report EXCEPT ![w] = IF held[w] >= MaxAttempts THEN "failed" ELSE "retry"]
 /\ outcome' = IF outcome = "running" /\ valid[w]
               THEN IF held[w] >= MaxAttempts THEN "failed" ELSE "partial" ELSE outcome
 /\ live' = IF outcome = "running" /\ valid[w] THEN {} ELSE live
 /\ expired' = IF outcome = "running" /\ valid[w] THEN TRUE ELSE expired
 /\ UNCHANGED <<attempt, held, valid, cursor, seen, staleWrite, terminalChanged>>

Reopen == /\ Variant = "terminal" /\ outcome \in Terminal
 /\ outcome' = "partial" /\ terminalChanged' = TRUE
 /\ UNCHANGED <<attempt, held, valid, phase, cursor, seen, expired, live, report, staleWrite>>
Next == (\E w \in Workers: Claim(w) \/ Crash(w) \/ Commit(w) \/ Release(w) \/ Fail(w)) \/ Expire \/ Reopen
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Expire) /\ SF_vars(\E w \in Workers: Claim(w))
            /\ WF_vars(\E w \in Workers: Crash(w) \/ Release(w) \/ Fail(w) \/ Commit(w))
CrashNext == (\E w \in Workers: Claim(w) \/ Crash(w)) \/ Expire
CrashSpec == Init /\ [][CrashNext]_vars /\ WF_vars(Expire) /\ SF_vars(\E w \in Workers: Claim(w)) /\ WF_vars(\E w \in Workers: Crash(w))
ProgressSpec == FairSpec /\ SF_vars(\E w \in Workers: Commit(w) /\ valid[w] /\ outcome = "running")
NoTwoLive == Cardinality(live) <= 1
NoStaleWrite == ~staleWrite
AtMostOnce == \A c \in 0..(Chunks-1): seen[c] <= 1
TerminalStable == ~terminalChanged
EventuallyTerminal == <> (outcome \in Terminal)
=============================================================================
