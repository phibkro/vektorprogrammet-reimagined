# State

**Lifecycle:** build (specs 0001 to 0003 merged as PRs #3, #4 and #6; spec 0004, the control panel as a dashboard, built and frozen at its pull request)

## Done

- Phase 1 architecture approved at Checkpoint 2 (2026-10-15).
- Slice 0000 ran on a deployed Worker → Hyperdrive (cache off) → Neon `dev` → `@effect/sql-pg` → Drizzle `effect-postgres`: 12 of 12 checks pass (`docs/specs/0000-results.md`). The first run failed check 3b because the Worker lacked `enable_request_signal`; the flag is now in the shared Worker config and must stay there. `tools/db-path-spike` has 39 tests. The spike Worker was torn down on 2026-10-16 at the operator's request; it can be redeployed.
- Spec 0001 (departments and semesters) is built end to end, to its six falsifiers (`docs/specs/0001-departments-and-semesters.md`, revisions R1 to R8). Its semester create form was removed by spec 0003.
- The import rehearsal on the real 2024-08-22 backup ran against a throwaway Neon branch (deleted afterwards): counts, quarantines and collapsed semesters are in `docs/specs/0001-import-rehearsal/`. It holds no personal data.
- CI runs format, lint, type check, the exception registry, every unit's tests, the browser tests, knip, jscpd and the secret scan on every pull request.
- Spec 0002 (Worker Previews) is merged: the base stage `main` runs on Neon `dev` with the importer's fake fixture, and every pull request gets a Cloudflare Worker Preview of it on its own Neon branch (`.github/workflows/preview.yml`, `apps/web/README.md` § Stages and previews).
- Spec 0003 (semesters by schedule) is built end to end, to its five falsifiers (`docs/specs/0003-semesters-by-schedule.md`, R1). Nobody creates semesters: the cron's `scheduled` handler runs `ensureScheduledSemesters` (the current and the next semester, one upsert each) beside the outbox sweep, and no page view writes. The create form, `createSemester`, `SemesterRepository.create`, the `ManageSemesters` capability, the `semester.created` audit action (one migration) and RULE-144 and 190 are gone. `readsNeverWrite.postgres.test.ts` runs every `runQuery` read path through a SELECT-only PostgreSQL role (negative control included). Tests: `packages/domain` 108, `packages/db` 47, `tools/import` 20, `apps/web` 69 plus 5 browser tests, `tools/db-path-spike` 39.
- Spec 0004 (the control panel as a dashboard) is built end to end, to its six local falsifiers (`docs/specs/0004-dashboard-shell.md`, R1 to R5; the seventh, CI and the Worker Preview, belongs to its pull request). `/kontrollpanel` is a shadcn Sidebar shell that owns the page (collapsible to icons, an off-canvas panel on a phone) with breadcrumbs, and every create, edit and inspect flow opens in a right-hand Sheet. What an actor sees is computed on the server from the domain's `authorize`, never from a role: the sidebar in `server/shell.ts`, each page's controls in the views of `server/panel.ts`. A control the actor lacks is not in the DOM, and a forged request for it still gets 403. `apps/web/test/shell.test.ts` shows each control exactly when its command would not refuse the actor. An anonymous visitor gets a plain not-signed-in page with no link to the panel. Tests: `packages/domain` 108, `packages/db` 47, `tools/import` 20, `apps/web` 77 plus 24 browser tests, `tools/db-path-spike` 39.

## Next

1. The operator reviews the spec 0004 pull request and merges it. The pull request description is the report, and its Worker Preview shows the dashboard on fake data.
2. Check the base stage `main`'s log for "semester job finished" (the semester job runs on the cron tick every 10 minutes, since the spec 0003 merge).
3. Phase 1 exit: the page-by-page diff against legacy.
4. The control-panel pages for static content, articles, sponsors and events are still at stub depth: a table and one Sheet form per capability (`apps/web/README.md`).
5. Phase 2 sign-in: the shell has no sign-in. Once an actor can sign in, the public header gets a control-panel link for a staff member, decided by the same `authorize` call; today no public page links to the panel.

## Blocked on the operator

- Authority to copy the production upload directories (file migration). Until then the importer reports every file as missing, and so does the rehearsal.
