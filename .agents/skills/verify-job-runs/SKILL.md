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

The claim and fenced write statements are in `repositories/jobRuns.ts`; the primary key and CHECKs in `schema.ts`; transaction and post-commit publication in `scheduler.ts`, `transactional.ts` and `publisher.ts`; eligibility and request scope in job declarations and scheduler. The model assumes one eligible period, finite workers/chunk positions, atomic transaction commit and serialized row updates. It does not check concrete runner cursor discipline or exactly-once provider delivery. Attempt count saturates at MaxAttempts only in pre-fix unbounded variants; independent validity flags preserve fencing across arbitrarily many takeovers. Expiry enables takeover; revocation is the attempt/outcome fence, not expiry alone.

The fixed current variant checks `NoTwoLive`, `NoStaleWrite`, `AtMostOnce`, `TerminalStable`, `HonestReports` and `DoneHasEnd`. `CrashSpec` now satisfies `EventuallyTerminal`: fair claims/crashes/expiry exhaust attempts and a claim atomically marks failed. `ProgressSpec` also passes. The `legacy` variant reproduces F-a (crash-only liveness), F-b (false stale report) and F-c (arbitrary writer stores done without endedAt). Individual `unbounded`, `reports`, `check` variants each remove only their fix. Existing broken `holders`, `fence`, `atomic`, `terminal` controls retain their named safety violation. Budget release is overapproximated without requiring a preceding chunk; crash-only liveness does not rely on release. See specs 0033 and 0034 for findings, evidence and assumptions.
