# State

**Lifecycle:** build (specs 0001 and 0002 merged as PRs #3 and #4; spec 0003, semesters by schedule, built and frozen at its pull request)

## Done

- Phase 1 architecture approved at Checkpoint 2 (2026-10-15).
- Slice 0000 ran on a deployed Worker → Hyperdrive (cache off) → Neon `dev` → `@effect/sql-pg` → Drizzle `effect-postgres`: 12 of 12 checks pass (`docs/specs/0000-results.md`). The first run failed check 3b because the Worker lacked `enable_request_signal`; the flag is now in the shared Worker config and must stay there. `tools/db-path-spike` has 39 tests. The spike Worker was torn down on 2026-10-16 at the operator's request; it can be redeployed.
- Spec 0001 (departments and semesters) is built end to end, to its six falsifiers (`docs/specs/0001-departments-and-semesters.md`, revisions R1 to R8). Its semester create form was removed by spec 0003.
- The import rehearsal on the real 2024-08-22 backup ran against a throwaway Neon branch (deleted afterwards): counts, quarantines and collapsed semesters are in `docs/specs/0001-import-rehearsal/`. It holds no personal data.
- CI runs format, lint, type check, the exception registry, every unit's tests, the browser tests, knip, jscpd and the secret scan on every pull request.
- Spec 0002 (Worker Previews) is merged: the base stage `main` runs on Neon `dev` with the importer's fake fixture, and every pull request gets a Cloudflare Worker Preview of it on its own Neon branch (`.github/workflows/preview.yml`, `apps/web/README.md` § Stages and previews).
- Spec 0003 (semesters by schedule) is built end to end, to its five falsifiers (`docs/specs/0003-semesters-by-schedule.md`, R1). Nobody creates semesters: the cron's `scheduled` handler runs `ensureScheduledSemesters` (the current and the next semester, one upsert each) beside the outbox sweep, and no page view writes. The create form, `createSemester`, `SemesterRepository.create`, the `ManageSemesters` capability, the `semester.created` audit action (one migration) and RULE-144 and 190 are gone. `readsNeverWrite.postgres.test.ts` runs every `runQuery` read path through a SELECT-only PostgreSQL role (negative control included). Tests: `packages/domain` 108, `packages/db` 47, `tools/import` 20, `apps/web` 69 plus 5 browser tests, `tools/db-path-spike` 39.

## Next

1. The operator reviews the spec 0003 pull request and merges it. The pull request description is the report. After the merge, the base stage `main` runs the semester job on its first cron tick (every 10 minutes): check its log for "semester job finished".
2. Phase 1 exit: the page-by-page diff against legacy.
3. The control-panel pages for static content, articles, sponsors and events are still at stub depth (`apps/web/README.md`).

## Blocked on the operator

- Authority to copy the production upload directories (file migration). Until then the importer reports every file as missing, and so does the rehearsal.
