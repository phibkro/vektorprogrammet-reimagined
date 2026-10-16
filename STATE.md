# State

**Lifecycle:** build (Phase 1 scaffolded; slice 0001 spec not frozen until slice 0000 passes)

## Done

- Phase 1 architecture approved at Checkpoint 2 (2026-10-15).
- Scaffolded and verified: `packages/domain` (94 tests), `packages/db` (36, 23 on real PostgreSQL), `tools/import` (17, real MySQL → PostgreSQL round trip), `apps/web` (46 tests, build, dev-server journeys). 193 tests executed, 193 passing, 0 pending.

## Next

1. Slice 0000: a deployed Worker → Hyperdrive (cache off) → Neon spike (architecture §5). Needs operator authority and credentials.
2. Freeze `docs/specs/0001-departments-and-semesters.md` and build it to its falsifiers.
3. Phase 1 exit: page-by-page diff against legacy, CI on pull requests.

## Blocked on the operator

- Authority to deploy the slice 0000 spike (Cloudflare Workers Paid, Hyperdrive, a Neon branch).
- Authority to copy the production upload directories (file migration).
