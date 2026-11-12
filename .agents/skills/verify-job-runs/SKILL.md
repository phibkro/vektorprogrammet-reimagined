---
name: verify-job-runs
description: Model-check the job-run lease and chunk protocol when its scheduler, repository, schema, transactions or job declarations change.
---

# Verify job runs

Run `devenv shell --profile formal -- .agents/skills/verify-job-runs/run.sh`. `--touched <base>` prints `touched` or `untouched` based on committed changes; `--digest` prints the reviewed HEAD digest. The runner stores each TLC log and configuration under `VERIFY_OUT`, or a new temporary directory. It fails on drift or an unexpected TLC result. Review all covered source against the model before changing the digest. This is a bounded abstraction, not a PostgreSQL or external-delivery test. There is deliberately no `--code` mode.

## Coverage record

```coverage
sync-digest: 0c952a357d2dfbdcba0990d6cad4b3cfc49930a1
confirmed-at: 3f1d7168
apps/web/src/adapters/db/repositories/jobRuns.ts
apps/web/src/adapters/db/schema.ts
apps/web/src/server/background/scheduler.ts
apps/web/src/server/background/outbox/publisher.ts
apps/web/src/core/jobs
apps/web/src/adapters/db/transactional.ts
apps/web/drizzle
```

The claim and fenced write statements are in `repositories/jobRuns.ts`; the primary key and CHECKs in `schema.ts`; transaction and post-commit publication in `scheduler.ts`, `transactional.ts` and `publisher.ts`; eligibility and request scope in the job declarations and scheduler. The model assumes one eligible period, finite workers and chunk positions, atomic transaction commit and serialized row updates. It does not check the concrete runner's own cursor discipline or exactly-once provider delivery. The attempt counter is saturated at `MaxAttempts`, but validity is tracked independently and reset on every claim, preserving the fencing distinction across arbitrarily many takeovers. `FairSpec` requires eligible claims, expiry, and worker steps to be scheduled fairly, but permits crashes. `ProgressSpec` additionally assumes strong fairness of a valid chunk commit: if it becomes possible infinitely often, it eventually commits. This is stronger than merely having a scheduled tick.

The checks use `NoTwoLive`, `NoStaleWrite`, `AtMostOnce`, `TerminalStable` and `EventuallyTerminal`. Broken `holders`, `fence`, `atomic`, and `terminal` variants must violate their respective safety property. `CrashSpec` restricts the fair behavior to claims, crashes and expiry and must violate unconditional liveness; `ProgressSpec` must satisfy liveness. The model overapproximates budget release, allowing it without a preceding chunk; the crash-only counterexample does not rely on this. See spec 0033 for findings and scope.
