# Spec 0034: Honest, bounded job-run endings

## Goal and journey

An operator observing scheduled periods sees a bounded number of attempts, an honest lost-lease result instead of an uncommitted outcome, and a database that cannot store a completed run without its completion time. This follows the three findings in [spec 0033](0033-job-run-model.md).

## Constraints and values

Model first; preserve existing safety controls and the job/outbox transaction boundary. Use the existing `failed` terminal outcome for attempt exhaustion. A claim of an exhausted, eligible row atomically marks it failed without handing out another attempt; a live lease remains untouched. Claim success means a committed claim, not completed work. Fenced release/failure success means a committed update; no matching row means lost ownership. External effects remain at least once. No unrelated scheduler features, admission-alert changes, deployment, hosted migration or real mail.

## Falsifiers / definition of done

- F-a: repeated crash → expiry → reclaim cannot exceed the declared attempt bound, and fair crash-only execution eventually terminates as failed. An active final attempt is not killed prematurely.
- F-b: an expired/taken-over worker's release or failure returns a distinct typed lost result when its fenced update changes no row; the scheduler reports/logs lost, never partial/retry/failed for that rejected update.
- F-c: `outcome = done` requires non-null `ended_at` against every writer. A generated Drizzle migration refuses existing violating rows before changing constraints, without repairing data.
- TLC current/fixed variants pass safety and crash-only liveness; preserved pre-fix variants reproduce each finding. Existing holders/fence/atomic/terminal controls retain their named violations.
- Domain, job-run and scheduler PostgreSQL regression suites and `vp check` pass. Each fix is individually removed/mutated and its regression fails.
- Source coverage digest is refreshed only after source/model agreement. Commit locally by pathspec on `fix/job-run-findings`; do not push or create a PR.

## Evidence boundaries

TLC checks a finite abstraction (one eligible period, two workers, two chunk positions and attempt bound two), atomic serialized row updates, chunk/cursor commit and fairness. PostgreSQL tests check concrete conditional statements, constraints and migration behavior. Scheduler tests check reported outcomes. Neither establishes provider exactly-once delivery, arbitrary runner cursor discipline, deployment configuration or fairness of real ticks. The coverage digest checks reviewed source identity, not semantic equivalence.

## Revisions

- 2026-11-12: Initial contract. Model changes precede implementation; verification results will be recorded here as exercised.
- 2026-11-12: Chosen semantics: expiry enables takeover but does not independently revoke an attempt. The existing attempt/running fence remains authoritative. Release returns the typed literal union `partial | lost`; failure returns `retry | failed | lost`. The scheduler uses these results and logs an outcomes annotation. Claim receives the job's declared maxAttempts and atomically chooses takeover versus terminal failed with endedAt and an exhaustion reason. Existing stored rows above the threshold are terminalized on their next eligible claim, without incrementing again.
- 2026-11-12: Generated `20261112175014_job_run_done_ended` using `devenv shell -- bun run --cwd apps/web db:generate --name job_run_done_ended`; added a refusal-only preflight before the generated CHECK. PostgreSQL regression exercised refusal with an unchanged legacy-invalid row and successful application after explicit synthetic fixture correction. No hosted migration ran.
- 2026-11-12: Model-first run, before production edits: `taskset -c 0-3 devenv shell --profile formal -- .agents/skills/verify-job-runs/run.sh` exited 0; all 13 cases matched. Initial logs: `/tmp/verify-job-runs.BRAnPZ`. Current and progress explored 867 generated / 337 distinct states each; crash-only fixed explored 71 / 43. Legacy crash-only and individual unbounded explored 97 / 49 and violated EventuallyTerminal. Legacy-report and reports violated HonestReports; legacy-check and check violated DoneHasEnd. Existing holders, fence, atomic and terminal violated NoTwoLive, NoStaleWrite, AtMostOnce and TerminalStable respectively.
- 2026-11-12: Domain command `taskset -c 0-3 devenv shell -- bunx vp -C apps/web test --project domain`: 47 files / 419 tests passed. Focused PostgreSQL commands `taskset -c 0-3 devenv shell -- bunx vp -C apps/web test --project db test/db/jobRuns.postgres.test.ts --maxWorkers 2` and the corresponding `--project web test/jobs.postgres.test.ts`: 12 and 10 tests passed after mutation restoration. They include existing interruption/rollback and chunk-resume cases. The initial scheduler run exposed shared-fixture pollution from the new stale-report fixture; removing its synthetic row fixed that test isolation defect.
- 2026-11-12: Failing-before evidence: with only exhausted predicate mutated to SQL false, `-t 'F-a:'` failed both crash/takeover and budget-release regressions (Claimed instead of Finished). With stale release outcome restored to partial, repository and scheduler `-t 'F-b:'` failed (partial instead of lost). With release fixed but the failure zero-row branch removed, both failed (retry instead of lost). With only the generated CHECK mutated to true, `-t 'F-c: PostgreSQL'` failed because invalid insert succeeded. All mutations were restored before the passing focused suites. The model's individual unbounded/reports/check variants are the permanent corresponding controls.
- 2026-11-12: Shared-machine admission used approximately 14–15 GiB MemAvailable out of 64 GiB, low CPU/memory PSI and lightly utilized NVMe devices despite high aggregate I/O PSI; jobs were serialized on CPUs 0–3 with at most two Vitest workers. Lead granted port 54321 custody. `devenv up -d` ran only in this worktree and `devenv down` succeeded afterwards; custody was returned. Synthetic data only.
- 2026-11-12: Installed Effect, sql-pg, platform-node, sql-pglite and vitest: 4.0.6; @effect/tsgo: 0.53.1. No dependency pins, exceptions or suppressions added. Reused existing Drizzle generator, conditional UPDATE, repository layer, test layers/TestClock and publication boundary. Installed AGENTS, schema/basics/DateTime/SQL/testing examples and Logger/Option source cover the APIs used; there was no missing installed API entry requiring a substitute. No effect-house overlay exists in this checkout.
- 2026-11-12: `taskset -c 0-3 devenv shell -- bunx vp check` passed: all 885 files formatted, no warnings/lint/type errors in 681 files, including Effect diagnostics. The implementation commit's pre-commit staged checks, secret scan and commitlint passed. Reviewed model/source agreement at `8ba62c5`; only then refreshed the covered-tree digest to `aa4c25676d898a79699dea7959ea1ee08f2559e1`.
- 2026-11-12: Not run: full workspace ready/test:all, unrelated PostgreSQL suites, fresh production build, full browser suite, hosted migration/deployment and provider-delivery probes. The assigned behavior is bounded job protocol/model, concrete repository/schema and scheduler reporting; these broader checks are not claimed.
- 2026-11-12: Final digest-gated formal command exited 0 against implementation `8ba62c5`; all 13 variants matched. Logs/configs: `/tmp/verify-job-runs.5mbQX4`. `devenv shell -- bunx vp run check:exceptions` also passed (registry clean; no new exception).

### Final TLC state counts

Generated/distinct counts are bounded exploration results, not proofs about all deployments. Negative controls stop at their counterexample; parallel exploration can change their detection counts.

| Case / counterexample log | Generated | Distinct | Result |
| --- | --: | --: | --- |
| current.out | 867 | 337 | Safety passes |
| progress.out | 867 | 337 | EventuallyTerminal passes |
| crashes.out | 71 | 43 | Crash-only EventuallyTerminal passes |
| legacy-crash.out | 97 | 49 | F-a: temporal counterexample |
| unbounded.out | 97 | 49 | F-a alone: temporal counterexample |
| legacy-report.out | 87 | 69 | F-b: HonestReports violated |
| reports.out | 148 | 95 | F-b alone: HonestReports violated |
| legacy-check.out | 12 | 10 | F-c: DoneHasEnd violated |
| check.out | 12 | 10 | F-c alone: DoneHasEnd violated |
| holders.out | 16 | 12 | NoTwoLive violated |
| fence.out | 175 | 100 | NoStaleWrite violated |
| atomic.out | 27 | 23 | AtMostOnce violated |
| terminal.out | 82 | 54 | TerminalStable violated |
