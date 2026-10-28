# Isolation check

`GET /api/isolation` reports what the store says about the isolation of its transactions, and whether that is what the domain promises (spec 0018, R9 and R10). It is a check for operators and for the pull request's job, not a page: no one is signed in for it, and it holds no personal data. The route asks the store three things through the domain's `IsolationProbe` and answers with them as JSON.

## Sub-features

- `isolation-report` a local or Preview deployment answers `200` with `{"probe":"serializable","roleDefault":"read committed","transactor":"read committed","problems":[]}`: a `Transactor.run` transaction reads `read committed`, a transaction that the adapter begins at SERIALIZABLE reads `serializable` (so a platform that drops the clause is seen), and the role's default, which the statements outside a transaction run at, reads `read committed`.
- `isolation-fails` a store whose role defaults to SERIALIZABLE answers `500` with the same three levels and a `problems` list that names the role's default; the `transactor` level still reads `read committed`, which is the explicit `BEGIN` doing its work.
- `isolation-read-only` the route writes nothing: a `GET` and a `HEAD` answer, a `POST` is not a way to run it (below), and `apps/web/test/readsNeverWrite.postgres.test.ts` runs it as a role that can only `SELECT`.
- `isolation-production` a production deployment answers an empty `404` and opens no domain transaction. Not drivable on this stack (`DEPLOYMENT=local`); `apps/web/test/isolation.postgres.test.ts` covers it with a probe that fails the test when it is used.

## How to get to it (user POV)

- Open `<origin>/api/isolation` in a browser or run `curl -i <origin>/api/isolation`. On a Worker Preview the pull request's `deploy` job does the same (step "Check the isolation level through Hyperdrive") and fails unless the answer is `200`.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK`; `state.env` names `E2E_BASE_URL` and `E2E_DATABASE_URL` (the disposable database).
- Nobody has changed the database's `default_transaction_isolation`. Leave it as it was: step 3 changes it and puts it back.

Steps:

- **The report.** `scripts/page.sh /api/isolation --as anonymous --name api-isolation-local` prints `GET /api/isolation as anonymous -> 200`; `pages/api-isolation-local.html` holds the JSON above and `pages/api-isolation-local.headers` has `content-type: application/json; charset=utf-8` and `cache-control: no-store`. The three levels must be exactly those: a `probe` of `read committed` would mean the platform dropped the clause.
- **Other methods.** `curl -sS -I <origin>/api/isolation` answers `200` with `cache-control: no-store`. `curl -sS -i -X POST <origin>/api/isolation` answers `403 Forbidden` (the dev server's check of the request's origin, observed 2026-10-28); with `-H "Origin: <origin>"` the router answers its HTML page with `200` and runs no handler, so no method but `GET` and `HEAD` reaches the probe. `curl -sS -o /dev/null -w '%{http_code}' <origin>/api/isolation/x` answers `404`.
- **The check can fail.** Set the disposable database's default and ask again, then put it back: `psql "$E2E_DATABASE_URL" -c "alter database ${E2E_DATABASE_URL##*/} set default_transaction_isolation = 'serializable'"`, `curl -sS -i <origin>/api/isolation` → `500` and a `problems` entry `the role's default reads "serializable", not "read committed"`, with `"transactor":"read committed"`; then `psql "$E2E_DATABASE_URL" -c "alter database ${E2E_DATABASE_URL##*/} reset default_transaction_isolation"` and the next answer is `200` again. (Every request builds its own connection, so the new default reaches the next request without a restart.)
- **Proof.** `scripts/report.sh --features "isolation-report, isolation-fails, isolation-read-only"`; attach `pages/api-isolation-local.*` and the output of the `curl` calls.

## Gotchas

- The route answers `500` on purpose when the store is not what the domain promises; a `500` here is the check working, not a crash. Read the body before you call it a fault.
- The levels are what the store names them in lower case (`read committed`, `serializable`); the route compares exactly those strings.
- Production's `404` and Hyperdrive's behaviour are not drivable here. The Hyperdrive half is the pull request's `deploy` job (its log prints `isolation report on the Preview: HTTP 200` and the JSON); do not claim it verified from this stack.
- The role-default assertion covers the test server and every pull request's Preview (the `main` stage answers the route too, but no job asks it). Production answers `404` and asserts nothing about its role's default until it is deployed; STATE.md names the follow-up (spec 0018 R18). A green isolation step on a pull request says nothing about production's role.
