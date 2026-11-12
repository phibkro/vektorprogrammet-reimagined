# Spec 0033: Job-run protocol model

## Goal

An engineer changing the scheduled-job protocol can model-check concurrent claims, lease expiry, crashes and chunk commits, and can see which source changes require a renewed review of the model.

## Constraints and values

Model the existing code, not a repaired protocol. One job and period, finitely many workers and cursor positions are sufficient to explore interleavings, not to prove arbitrary deployment behavior. Attempt fencing and chunk/cursor atomicity are port/transaction assumptions, not database-wide guarantees. External delivery is not exactly once. No production code changes in this slice.

## Journey

An engineer reviews the source mapping and assumptions, runs the verifier in the formal devenv profile, sees the current bounded model pass its stated properties and each broken variant fail its named property, and consults the saved TLC logs. A pull request touching covered source or the verifier triggers the same check; an unreviewed change to the covered source fails the digest check.

## Falsifiers

- A concurrent live claim exists for two holders, a stale attempt commits a chunk or finish, a cursor position commits twice, or a terminal outcome changes.
- With the stated progress assumptions a due eligible period never becomes done or failed.
- Any deliberately broken property variant does not produce its expected TLC violation, or the verifier accepts a parse/tool error as a counterexample.
- `--touched` omits a covered change or incorrectly treats an unchanged branch as touched; changed covered content escapes the digest gate.
- The model claims provider delivery exactly once, or ignores the distinction between code-enforced behavior and arbitrary database writes.

## Source findings

- `jobRuns.ts` conditions writes on both `attempt` and `running`. `release` and `fail` discard the boolean from that write. A stale release returns normally and the scheduler reports `partial`; a stale fail returns `retry` or `failed` computed from its old attempt, even though it wrote no row. The stored newer outcome is not overwritten, but the period report can be false (`scheduler.ts:132–160`).
- `schema.ts` has independent checks for job, outcome and nonnegative attempt, not cross-field checks: a `done` row with null `ended_at` is representable via another writer. The repository's `finish` sets both in one write; this is not a store-enforced invariant.
- `claim` increments attempt on takeover without a maximum; `maxAttempts` is tested only in `fail`. Unlimited crashes and expired-lease takeovers can therefore continue indefinitely without `failed`. Liveness requires a further assumption that eventually an attempt progresses to a committed chunk or records failure, not merely fair ticks and time. A proposed cadence has no automatic due periods; an explicit request needs an eligible tick.
- `oneChunk` runs prepared work and `advance`/`finish` in one transaction; a failed fence rolls that work back. `publishingAfterCommit` publishes after the transaction succeeds; crashes and delivery retries remain possible afterwards.

## Revisions

- 2026-11-12: Initial contract and source findings. Verification evidence will be recorded after the model run.

- 2026-11-12: **F-a — liveness:** `crashes.out` from `/tmp/verify-job-runs.YiMm0C` shows claim → crash → lease expiry → reclaim looping indefinitely after the abstract count reaches the failure threshold. Claim has no maximum guard; no failure is recorded in this trace. The count saturation is only an abstraction; separate validity flags preserve distinct attempt fencing. `ProgressSpec` adds strong fairness for committing a valid chunk and passes; this is an environmental assumption, not a production guarantee.
- 2026-11-12: **F-b — stale reports:** `release` returns normally and `fail` returns an attempt-derived status even when its fenced write matched no row. The scheduler logs the resulting period report, which can disagree with the newer stored outcome. The database row remains fenced.
- 2026-11-12: **F-c — schema:** `done` with null `ended_at` remains representable by a writer outside the port; no cross-field CHECK prevents it.
- 2026-11-12: TLC 2.19, two workers, two cursor positions, maximum attempt threshold 2: `current.out` and `progress.out` each explored 3,813 generated / 953 distinct states; each passed. Negative `holders.out`, `fence.out`, `atomic.out`, `terminal.out` violated respectively `NoTwoLive`, `NoStaleWrite`, `AtMostOnce`, `TerminalStable` (16, 94, 27, 74 distinct states at detection). `crashes.out` checked 49 distinct states and violated liveness. Suite wall time 5.41 s; each run took 0–1 s. Logs and generated configurations were kept under `/tmp/verify-job-runs.YiMm0C` on the verifying host.
- 2026-11-12: The model overapproximates budget release (it permits release before a chunk); this can only add behaviors and is not an exact scheduler simulation. The dedicated crash-only lasso does not rely on release. Cursor progression and deterministic chunk selection are assumptions, and neither a database test nor provider delivery is claimed.
- 2026-11-12: The `--touched` admission check also verifies the covered HEAD digest and exits 3 on drift, so CI refuses unreviewed covered source before running TLC.
