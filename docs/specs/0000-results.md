# Spec 0000 results: the database-path spike

Contract: [`0000-database-path-spike.md`](0000-database-path-spike.md). Runbook, secret route and teardown: [`tools/db-path-spike/README.md`](../../tools/db-path-spike/README.md).

## Verdict

**All 12 lines (11 checks) pass on the deployed Worker, on the final run, from the committed tree.** The first run did not: **check 3b failed**, and the failure was real. A client that aborted a request mid-transaction did not stop the transaction, which committed 20 s later. The cause is a Worker setting, not the database stack: `request.signal` only fires with the compatibility flag `enable_request_signal`, which has no default date, and `apps/web/worker.config.ts` (shared by the spike) did not set it. The flag is now in that file. Without it three runs failed 3b; with it three runs passed (table below).

| Question in the spec | Answer |
| --- | --- |
| Do checks 1–8 pass? | Yes on the final run. Check 3b failed first, with the production flags as they were. |
| Which §4 fallback applies? | **None.** The fallbacks replace the driver (`pg`) or the host (Vercel). The failure was a platform setting, and with that setting the Effect stack passes every check. |
| Spec 0001 freeze | Unblocked by the final run, **on one condition**: `enable_request_signal` stays in `apps/web/worker.config.ts`. Removing it silently turns every cancelled request into a committed write. Read strictly, the first run triggered the spec's "any of checks 1–8 fails" clause: this file names the check, the error and the cause, and answers the fallback question (none), and the final run passes. The freeze itself is the operator's call. |

## What ran

|  |  |
| --- | --- |
| Date | 2026-10-16 (runs 07:18–07:39 UTC) |
| Worker | `vp-spike-0000`, `vp-spike-0000.philib-krogh-d23.workers.dev`; final script version `0eaeb2b6-99c6-4cc2-becd-55a63ee37022` |
| Hyperdrive config | `vp-spike-0000-neon-dev`, id `c1c9a606c1404cb6a261d3292a7921c0`; caching disabled (read back from the Cloudflare API: `caching.disabled: true`); origin Neon `dev` branch as role `vp_app` |
| Neon | project `bold-poetry-64036846`, branch `dev`, PostgreSQL 18.6 (653b019), aws-eu-central-1 |
| Worker compatibility | date `2026-10-01`, flags `nodejs_compat`, `enable_request_signal` (from `apps/web/worker.config.ts`) |
| Versions | effect 4.0.5, @effect/sql-pg 4.0.5, drizzle-orm 1.0.0-rc.5-5935859, sanitize-html 2.18.1, bcryptjs 3.0.3, alchemy 2.0.0-beta.83, cf 1.0.0-beta.12, Bun 1.4.2 (the runner), @cloudflare/workers-types 5.20261015.1 |
| Deployed from | the committed tree: `deploy --dry-run` from the clean tree reported `Plan: no changes` for both resources just before the final run |
| Every request of the final run | served by script version `0eaeb2b6` (Workers Logs: 45 invocations, 1 `canceled` (the aborted request), 44 `ok`) |

## The final run, verbatim

Command (from the repository root, clean tree):

```sh
devenv shell -- bun run --cwd tools/db-path-spike smoke --url https://vp-spike-0000.philib-krogh-d23.workers.dev
```

```text
$ bun src/smoke.ts --url "https://vp-spike-0000.philib-krogh-d23.workers.dev"
slice 0000 database-path spike
worker vp-spike-0000.philib-krogh-d23.workers.dev · run run-g4lnyb3wr7z1 · 2026-10-16T07:38:52.877Z
PASS  1   connect and select 1 through PgClient and Drizzle effect-postgres
          select 1 = 1 through the SqlClient and 1 through Drizzle; the Worker's only database address is Hyperdrive (9aa0b555da92ff235552ba0533691986.hyperdrive.local); vp_app@vektorprogrammet, PostgreSQL 18.6 (653b019); Worker version 0eaeb2b6-99c6-4cc2-becd-55a63ee37022
PASS  2   a transaction that commits
          the transaction returned; a later request reads ["commit"]
PASS  3a  rollback on a typed failure
          failed with SpikeRollback; a later request reads []
PASS  3b  rollback on interruption (the request is aborted mid-transaction)
          the aborted transaction's key was free after 197 ms and a later request reads []
PASS  4   nested savepoint: inner failure, outer commit
          inner failed with SpikeRollback; a later request reads ["outer"]
PASS  5   INSERT ... ON CONFLICT ... RETURNING
          DO NOTHING returned id 131, then no row; DO UPDATE returned id 133, then id 133
PASS  6   unique violation classified by classifySqlFailure
          the duplicate insert failed as AlreadyExists(Semester, "VAR 274096838")
PASS  7   timestamptz, date, jsonb and numeric round trips
          5 samples (two DST-edge instants among them) written through Drizzle and through the SqlClient and read back through both: all 20 reads equal
PASS  8   20 concurrent ON CONFLICT upserts on one key
          20 concurrent upserts all returned the row 137; 1 row for the key
PASS  9   sanitize-html with the RULE-133 allowlist against an XSS corpus
          29 XSS payloads neutralised exactly as in Node; every allowed tag and attribute survived
PASS  10  bcrypt $2y$12$ verification and its CPU time
          $2y$12$ hash verified and a wrong input was refused; request 349 ms against a 8 ms no-op request, so at most 341 ms of CPU (client-observed wall clock, an upper bound)
PASS  11  Hyperdrive cache is off: a write is read back at once
          10 writes, each read back at once with the same query text in the same and in a later request: every read returned the value just written
12 of 12 checks passed
```

Exit code 0. The verdicts are computed by the runner from the Worker's answers; the Worker never reports pass or fail.

## Check 3b: failed first, then passed with one setting

### The failing run, verbatim

The same command against script version `ba32d0c6-f96b-472d-b1b4-718ee2404ec2`, which had the production flags exactly as `apps/web` had them (`nodejs_compat` only). Exit code 1.

```text
slice 0000 database-path spike
worker vp-spike-0000.philib-krogh-d23.workers.dev · run run-ihjm982n9h4o · 2026-10-16T07:27:05.898Z
PASS  1   connect and select 1 through PgClient and Drizzle effect-postgres
          select 1 = 1 through the SqlClient and 1 through Drizzle; the Worker's only database address is Hyperdrive (0d7178ff020199a5d0898c98679143f5.hyperdrive.local); vp_app@vektorprogrammet, PostgreSQL 18.6 (653b019); Worker version ba32d0c6-f96b-472d-b1b4-718ee2404ec2
PASS  2   a transaction that commits
          the transaction returned; a later request reads ["commit"]
PASS  3a  rollback on a typed failure
          failed with SpikeRollback; a later request reads []
FAIL  3b  rollback on interruption (the request is aborted mid-transaction)
          the aborted transaction COMMITTED: its key was taken after 20084 ms (rows ["abort"])
PASS  4   nested savepoint: inner failure, outer commit
          inner failed with SpikeRollback; a later request reads ["outer"]
PASS  5   INSERT ... ON CONFLICT ... RETURNING
          DO NOTHING returned id 79, then no row; DO UPDATE returned id 81, then id 81
PASS  6   unique violation classified by classifySqlFailure
          the duplicate insert failed as AlreadyExists(Semester, "VAR 1703475013")
PASS  7   timestamptz, date, jsonb and numeric round trips
          5 samples (two DST-edge instants among them) written through Drizzle and through the SqlClient and read back through both: all 20 reads equal
PASS  8   20 concurrent ON CONFLICT upserts on one key
          20 concurrent upserts all returned the row 85; 1 row for the key
PASS  9   sanitize-html with the RULE-133 allowlist against an XSS corpus
          29 XSS payloads neutralised exactly as in Node; every allowed tag and attribute survived
PASS  10  bcrypt $2y$12$ verification and its CPU time
          $2y$12$12 hash verified and a wrong input was refused; request 375 ms against a 6 ms no-op request, so at most 369 ms of CPU (client-observed wall clock, an upper bound)
PASS  11  Hyperdrive cache is off: a write is read back at once
          10 writes, each read back at once with the same query text in the same and in a later request: every read returned the value just written
11 of 12 checks passed; failed: 3b
```

The check 10 line printed the hash cost twice (`$2y$12$12`); that evidence text was fixed in the next commit and changes no verdict.

### Controlled comparison

Six runs of check 3b on four script versions. The `abort` rows are the platform's own record of the aborted request (Workers Logs, `cf observability telemetry query`).

| Run (UTC) | Script version | `enable_request_signal` | Platform outcome of the aborted request | Aborted request lived | Check 3b says |
| --- | --- | --- | --- | --- | --- |
| 07:18:27 | `b6f7d66b` | no | `canceled` | 20 135 ms | FAIL: committed, key taken after 20 064 ms |
| 07:21:38 | `b6f7d66b` (see the note) | no | `canceled` | 20 121 ms | FAIL: committed, key taken after 20 093 ms |
| 07:23:28 | `163aed3e` | yes | `canceled` | 122 ms | PASS: key free after 265 ms, no row |
| 07:27:26 | `ba32d0c6` | no | `canceled` | 20 151 ms | FAIL: committed, key taken after 20 084 ms |
| 07:29:06 | `0eaeb2b6` | yes | `canceled` | 127 ms | PASS: key free after 233 ms, no row |
| 07:38:53 | `0eaeb2b6` | yes | `canceled` | 160 ms | PASS: key free after 197 ms, no row |

Every other check passed in every one of the six runs.

How to read it:

- The platform noticed the client leaving in all six runs (`canceled`). Without the flag the Worker was not told: `request.signal` never aborted, the fiber slept out its 20 s hold and committed. With the flag the signal aborted, the fiber was interrupted, `@effect/sql-pg` rolled the transaction back through Hyperdrive, and the lock the aborted transaction held on the key was free after about 0.2 s.
- The check can fail on the real platform; that is the evidence that it is not vacuous. Locally it is also proven by a negative control: a transaction that nothing interrupts makes it fail.
- **Cause, from Cloudflare's documentation:** [`enable_request_signal`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests) is listed without a "Default as of" date, so it is opt-in at any compatibility date. See also the [announcement](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/).
- **Fix, at the source:** `apps/web/worker.config.ts` now sets `COMPATIBILITY_FLAGS = ["nodejs_compat", "enable_request_signal"]`. `apps/web/alchemy.run.ts`, `apps/web/vite.config.ts` and the spike all read that constant. `apps/web/src/server/runtime.ts` already runs each program with `request.signal` and documents that a cancelled request rolls back; before this change that was not true on a deployed Worker.
- Note on the second run: it was meant to test the new version. The platform still served that one request on the first version 28 s after the upload finished, while a request 51 ms later ran on the new one. Check 1 now names the script version, so a run that mixes versions cannot pass unnoticed.
- Limit: the spike Worker follows the production pattern (`Effect.runPromise(program, { signal: request.signal })`). `apps/web` itself was not deployed.

## Check 10: bcrypt `$2y$12$` on Workers

Platform-reported CPU time (Workers Logs `cpuTimeMs`) of the 12 verification requests across the six runs, each request verifying one hash once:

|  | CPU per request |
| --- | --- |
| min / median / max | 316 ms / 340 ms / 486 ms |
| all 12, sorted | 316, 331, 332, 334, 340, 340, 342, 356, 361, 372, 434, 486 |
| final run | 340 ms and 332 ms |
| outcome of all 12 | `ok` (no `exceededCpu`) |

`bcryptjs` 3.0.3 is pure JavaScript and blocks the isolate for the whole verification. The Free plan caps a request at 10 ms of CPU ([limits](https://developers.cloudflare.com/workers/platform/limits/): 10 ms Free, 30 s default and 5 min maximum Paid), so a Free account would have ended these requests with `exceededCpu`. They finished, so the account is not on Free; the plan was not read from a billing API. The run output reports only an upper bound (the client's wall clock minus a no-op request), because a Worker cannot measure its own CPU time.

Input for Phase 2 (critique M8): one login verification costs about 0.3 to 0.5 s of CPU on Workers, against the 10–20 ms the platform documents for heavier requests. It fits Workers Paid; it does not fit Free.

## How it was run

|  |  |
| --- | --- |
| Resources created | Worker `vp-spike-0000` (workers.dev); Hyperdrive config `vp-spike-0000-neon-dev`; Neon schema `spike_0000` (4 tables) and journal table `public.spike_0000_migrations`; Alchemy state `vp-spike-0000/spike/{Database,Worker,output}` in the account's shared state store. Nothing else was touched. |
| Spike tables | applied as `neondb_owner` over a direct connection by `drizzle-kit migrate`; `vp_app` has USAGE on the schema and DML on the tables, no CREATE, no TRUNCATE. |
| Hyperdrive origin password | `NEON_APP_PASSWORD` from SecretSpec, read with `Config.Redacted` into the Alchemy Hyperdrive resource. Alchemy keeps it in the state document as a plain string inside `{"__redacted__": …}` (key paths `props.origin.password` and `attr.origin.password` of `Database`, and the embedded binding in `Worker`, 32 characters each); the Cloudflare state store encrypts each document at rest (AES-CTR). So it is encrypted in state, not absent from it. Cloudflare validates the origin on create, so a placeholder cannot stand in; the alternative is a `cf`-created Hyperdrive config that Alchemy cannot bind by id without reaching into its internals. |
| Credential scan after the deploys | Searched for the Neon app password and the Cloudflare token values (without printing them) in the repository working tree, `tools/db-path-spike/.alchemy/`, `~/.alchemy/logs` and the captured Alchemy and smoke outputs: 0 files contain either. `.alchemy/` holds a version check (`checkedAt`, `distTags`), a log and the Worker bundle. No Alchemy state is stored locally; the remote documents hold no token field. |
| Cloudflare sign-in (deviation) | The Alchemy profile `production` was `needs-reauth` (refresh token rejected, interactive sign-in needed). With the approval of the main agent, Alchemy ran with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` taken from the operator's `cf` OAuth session for the same account, set only in the Alchemy process's environment. The profile file is unchanged (modified 2026-09-23). To restore the normal path: `devenv shell -- bunx alchemy profile refresh --profile production --provider Cloudflare`. |
| Teardown | `bun run --cwd tools/db-path-spike teardown` through `with-neon-env.sh both` (runbook). `alchemy destroy --dry-run` lists exactly two deletions, the Hyperdrive config and the Worker; the SQL half (`drop schema spike_0000 cascade`, drop the journal table) ran against a scratch database and left an unrelated table alone. The spike stays deployed. |

## What this does not show

- One run per deployment is a sample, not a distribution: check 8 ran 20-way six times without a pool or prepared-statement error, which is evidence for the spec's claim, not a bound.
- Whether a run met a cold (suspended) Neon compute was not recorded, so the timings in this file are not a cold-start measurement.
- Only the `dev` branch and role `vp_app` were exercised; `apps/web` was not deployed; the Free plan was inferred, not read.
- `apps/web` also needs `@effect/platform-bun` (or `@effect/platform-node`) in its dev dependencies before its own `alchemy.run.ts` can start; this package carries `@effect/platform-bun` for that reason.
