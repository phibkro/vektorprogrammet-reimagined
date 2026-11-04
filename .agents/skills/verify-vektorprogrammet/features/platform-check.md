# Platform check

`GET /api/platform` shows what the store does with the properties that the domain asks of its platform (spec 0025): two transactions on two pooled connections, a rolled-back write, a nested scope, and whether the client names its statements. It is a check for operators and for the pull request's job, not a page: no one is signed in for it, and it holds no personal data. The route asks the store through the domain's `PlatformProbe` and answers with the report as JSON. `docs/system/database-platforms.md` (generated) says what each check is for and what Hyperdrive does with each construct.

## Sub-features

- `platform-report` a local or Preview deployment answers `200` with `{"checks":[…],"profile":"hyperdrive","deployment":"local","problems":[]}`. Every check is `held: true` with what was observed: `rollback-leaves-nothing`, `nested-scope-undoes-alone`, `lock-excludes-second-holder` (the second transaction is refused with SQLSTATE `55P03` while the first holds the admin list's row), `lock-ends-with-its-transaction`, `held-record-is-not-handed-on` (a claimer that skips locked rows gets 0 rows, then 1) and `statements-follow-the-profile`. Under this stack the connection is direct: the report names the profile and the deployment and cannot tell a pooler from none.
- `platform-fails` a check that did not hold, or one that is missing, answers `500` with a `problems` list that names the check. A lock that another command holds for more than three seconds makes the three lock checks fail with SQLSTATE `55P03` (the probe sets a `lock_timeout`), and the other checks are still reported.
- `platform-not-a-read` the route is not a read path: it takes the admin list's row lock for a few milliseconds and writes mailbox rows that it rolls back, so `readsNeverWrite.postgres.test.ts` does not run it as a role that can only `SELECT`. It runs through `runOutcome`, never `runQuery`. It is unauthenticated, like `/api/isolation`.
- `platform-production` a production deployment answers an empty `404` and runs no probe. Not drivable on this stack (`DEPLOYMENT=local`); `apps/web/test/platform.postgres.test.ts` covers it at `runPlatformRoute`, the function that the route calls.

## How to get to it (user POV)

- Open `<origin>/api/platform` in a browser or run `curl -i <origin>/api/platform`. On a Worker Preview the pull request's `deploy` job does the same (step "Check the isolation level and the platform through Hyperdrive", after `/api/isolation`) and fails unless the answer is `200`.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK`; `state.env` names `E2E_BASE_URL` and `E2E_DATABASE_URL` (the disposable database).

Steps:

- **The report.** `scripts/page.sh /api/platform --as anonymous --name api-platform-local` prints `GET /api/platform as anonymous -> 200`; `pages/api-platform-local.html` holds the JSON, and `pages/api-platform-local.headers` has `content-type: application/json; charset=utf-8` and `cache-control: no-store`. Every check must be `held: true`, `problems` must be `[]`, and `profile` must be `hyperdrive` (the profile that `DatabaseLive` is configured with, whatever the connection under it).
- **The browser test.** `scripts/drive.sh platform.spec.ts` (one test) passes.
- **The check can fail.** Hold the admin list's row in another session and ask: `psql "$E2E_DATABASE_URL" -c "begin; select id from admin_list for no key update; select pg_sleep(8); rollback" &` then at once `curl -sS -i <origin>/api/platform`: after about three seconds the answer is `500` with three `problems` that name `lock-excludes-second-holder`, `lock-ends-with-its-transaction` and `held-record-is-not-handed-on`, each `failed with SQLSTATE 55P03` (a held lock is a probe that cannot run, not a hang). Ask again after the `psql` has finished: `200`.
- **Nothing is left behind.** `psql "$E2E_DATABASE_URL" -tAc "select count(*) from captured_mail where delivery_key like 'platform-probe-%'"` prints `0` after any of the above.
- **Proof.** `scripts/report.sh --features "platform-report, platform-fails, platform-not-a-read"`; attach `pages/api-platform-local.*` and the output of the `curl` calls.

## Gotchas

- The route answers `500` on purpose when the platform does not show what the domain asks; a `500` here is the check working, not a crash. Read the body before you call it a fault.
- A `200` on this stack shows the adapter's constructs on **PostgreSQL**, not through Hyperdrive. The Hyperdrive half is the pull request's `deploy` job (its log prints `platform report on the Preview: HTTP 200` and the JSON); do not claim it verified from this stack.
- The probe takes a blocking row lock on the admin list for a few milliseconds on every request, on a stage with fake data. A flood of requests can queue the commands that lock the admin list behind it, for at most the probe's three seconds each; that is why a Preview or `main` stage answers it and production does not.
- `docs/system/database-platforms.md` is generated: `bun run docs` rewrites it, and `bun run check:docs` fails when it differs from `packages/domain/src/shared/platformRequirements.ts` and `packages/db/src/platform/`.
