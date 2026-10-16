# Spec 0000: Database-path spike (gate before spec 0001 is frozen)

**Status:** frozen (its pull request opened 2026-10-16); outcome in [`0000-results.md`](0000-results.md) · **Phase:** 1 · **Source:** `analysis/vektorprogrammet/REIMAGINED_ARCHITECTURE.md` §5 (architecture critique B1) · **Authority:** operator, 2026-10-16 ("rest is authorised"); Cloudflare account = Alchemy profile `production`; Neon project `bold-poetry-64036846`, branch `dev`.

## Journey

A developer deploys one throwaway Worker, then runs one command that sends HTTP requests to it. Each request runs a check through the production database stack: Worker → Hyperdrive (caching off) → Neon `dev` branch, as role `vp_app` → `@effect/sql-pg` with `prepare: false` → Drizzle `effect-postgres`. The command prints one line per check (pass or fail, with evidence) and exits 0 only if every check passes. The same command later becomes the CI smoke test against a deployed preview.

## Goal, constraints, values

- **Goal:** prove or disprove, on the real platform, the one seam every slice depends on, before slice 0001 builds on it.
- **Constraints:**
  - The Worker uses `@vektorprogrammet/db`'s real `DatabaseLive` and `transactional`, not a copy. Exact pins as in the root catalog.
  - The spike's checks use their own tables (prefix `spike_`) on the Neon `dev` branch, created by a migration the spike owns, and leave the Phase 1 tables untouched. `vp_app` keeps DML-only rights; any DDL runs as `neondb_owner` over a direct connection, outside the Worker.
  - No secret value in the repo, Alchemy state or logs. The Hyperdrive origin password (`NEON_APP_PASSWORD`) comes from SecretSpec and reaches Cloudflare only through stdin (`cf`), or through an Alchemy secret input that is not persisted in plain text. The infra file records which.
  - Infrastructure is declared in Alchemy v2 (one root). `cf` is used only where Alchemy has no resource or a value must not enter Alchemy state.
  - Workers Paid is assumed; if the account is on Free, check 10 reports the CPU limit it hit instead of passing silently.
- **Values:** an honest negative is a successful spike. A failing check is reported with its error, never retried until green or worked around inside the spike.

## Checks (falsifiers; each one is a line in the output)

| # | Check | Pass means |
| --- | --- | --- |
| 1 | Connect and `select 1` through `PgClient` and Drizzle `effect-postgres` | a row comes back through Hyperdrive; the response states Hyperdrive was used, not a direct URL |
| 2 | `db.transaction` that commits | the row is visible to a later request |
| 3a | rollback on a typed failure | no row after the failure |
| 3b | rollback on interruption (the request is aborted mid-transaction) | no row afterwards |
| 4 | nested savepoint: inner failure, outer commit | outer row present, inner row absent |
| 5 | `INSERT … ON CONFLICT … RETURNING` | returns the row on insert, and the existing row on conflict (DO UPDATE) or empty (DO NOTHING) |
| 6 | unique violation classified by `classifySqlFailure` | maps to `AlreadyExists`, not a defect |
| 7 | round trips of `timestamptz`, `date`, `jsonb`, `numeric`, through Drizzle and through raw `SqlClient` | values equal after a write and a read, including a DST-edge `timestamptz` |
| 8 | 20 concurrent requests doing an `ON CONFLICT` upsert on one key | exactly one row; no request fails with a prepared-statement or pool error |
| 9 | `sanitize-html` with the RULE-133 allowlist in workerd, against an XSS corpus | every payload neutralised; the allowed tags survive |
| 10 | bcrypt `$2y$12$` verification of a fake hash on Workers | verifies, and reports the CPU time used (Phase 2 input, critique M8) |
| 11 | Hyperdrive cache is off | a write followed immediately by a read returns the new value |

## Definition of done

- The spike Worker is deployed with Alchemy using profile `production`. The run command's full output, from the deployed Worker, is committed to `docs/specs/0000-results.md`, with the date, the Worker URL host, the versions and the Hyperdrive config id (not secret).
- If every check passes: the spec 0001 freeze is unblocked, and the brief's Phase 1 entry note records it.
- If any of checks 1–8 fails: the result file says which, the error, and which fallback in `REIMAGINED_ARCHITECTURE.md` §4 applies next. Spec 0001 stays unfrozen.
- The pull request runs CI (the Phase 1 "CI on every pull request" criterion).
- Teardown is documented: the command that removes the Worker, the Hyperdrive config and the `spike_` tables.

## Out of scope

R2, mail, Slack, Turnstile, TanStack Start routing, Better Auth itself (only bcrypt verification), and the production branch.
