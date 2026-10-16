# State

**Lifecycle:** build (spec 0001 built to its falsifiers and frozen at its pull request; the rest of Phase 1 follows)

## Done

- Phase 1 architecture approved at Checkpoint 2 (2026-10-15).
- Slice 0000 ran on a deployed Worker → Hyperdrive (cache off) → Neon `dev` → `@effect/sql-pg` → Drizzle `effect-postgres`: 12 of 12 checks pass (`docs/specs/0000-results.md`). The first run failed check 3b because the Worker lacked `enable_request_signal`; the flag is now in the shared Worker config and must stay there. `tools/db-path-spike` has 39 tests.
- Spec 0001 (departments and semesters) is built end to end, to its six falsifiers (`docs/specs/0001-departments-and-semesters.md`, revisions R1 to R8). Tests: `packages/domain` 108, `packages/db` 36 (23 on real PostgreSQL), `tools/import` 20 (real MySQL → PostgreSQL round trip), `apps/web` 68 plus 5 browser tests (Playwright on `vp dev`, on data the real importer wrote), `tools/db-path-spike` 39.
- The import rehearsal on the real 2024-08-22 backup ran against a throwaway Neon branch (deleted afterwards): counts, quarantines and collapsed semesters are in `docs/specs/0001-import-rehearsal/`. It holds no personal data.
- CI runs format, lint, type check, the exception registry, every unit's tests, the browser tests, knip, jscpd and the secret scan on every pull request.

## Next

1. The operator reviews the spec 0001 pull request and merges it. The pull request description is the report.
2. Phase 1 exit: the page-by-page diff against legacy.
3. The control-panel pages for static content, articles, sponsors and events are still at stub depth (`apps/web/README.md`).

## Blocked on the operator

- Whether the slice 0000 spike stays deployed as the preview smoke test or is torn down (`tools/db-path-spike/README.md`). It stays until the operator decides.
- Authority to copy the production upload directories (file migration). Until then the importer reports every file as missing, and so does the rehearsal.
