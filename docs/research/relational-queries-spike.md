# Drizzle relational queries v2 (RQB) over the teams domain: spike

> **Status: throwaway research** on branch `spike/relational-queries` (from `35f6c54`). Nothing here is merged. The probes are in `packages/db/spike/`; the root `vite.config.ts` excludes that directory from format and lint on this branch only.

## Verdict

**Adopt later, not now.** RQB v2 works over `drizzle-orm/effect-postgres` (on `@effect/sql-pg`) and `drizzle-orm/effect-pglite` exactly as the repository uses Drizzle: it runs through the ambient `SqlClient`, it joins `SqlClient.withTransaction`, it nests as a savepoint, and it runs under the SELECT-only role. On both Drizzle builds it returned the same domain values as the current repositories for every read I compared. No blocker.

It does not pay for itself on the teams reads today:

| Read | Statements | Server time (PostgreSQL 18.6, 3000 persons) | Result size (as text) |
| --- | --- | --- | --- |
| Team page: team + memberships + names | 2 → 1 | 0.50 ms → 0.27 ms (end to end 0.97 → 0.78 ms) | 2.1 KB → 8.1 KB |
| All people + current memberships | 2 → 1 | 2.5 ms → 14.8 ms (end to end 8.1 → 23.4 ms) | 168 KB → 283 KB |
| The active memberships (membership side) | 1 → 1 | 1.2 ms → 1.1 ms | 26 KB → 48 KB |

The one gain is a saved statement (a round trip on Neon through Hyperdrive; not measured here, so that part is `[INFERENCE]`). The costs: a second description of the schema's relations (`defineRelations`) that someone must keep in step with the foreign keys, a changed `Drizzle` service type, a `where` contract that throws on `undefined`, up to four times the result size from repeated JSON keys, no ordering by a joined column, and generated columns typed `number | null`.

Adopt when all three hold:

1. The relations are **generated** from the kernel's `Relationship` declarations (see [Generating the relations](#generating-the-relations)), so there is no hand-written second copy.
2. The Drizzle pin is final `1.0.0-rc.5` (the paginated nested read is 4× faster there; see [rc.5](#differences-between-the-pinned-build-and-final-rc5)).
3. A screen needs a read that nests three levels or more, or a paginated nested read, where one RQB call replaces three or more hand joins and in-memory stitching. The two teams reads are one and two levels: hand joins already do them in one or two statements.

## What was run

| Item | Value |
| --- | --- |
| Pinned build | `drizzle-orm 1.0.0-rc.5-5935859` (the catalog) |
| Final build | `drizzle-orm 1.0.0-rc.5`, installed only in a scratch copy of `packages/db` (`packages/db-rc5`, rebuilt by `packages/db/spike/rc5-scratch.sh`; not committed, catalog untouched) |
| Effect | 4.0.5 (`effect`, `@effect/sql-pg`, `@effect/sql-pglite`); this worktree does not move the Effect line |
| Databases | PGlite 0.5.10 in memory; PostgreSQL 18.6 from `devenv up -d` (disposable `vp_db_test_*` databases through `@vektorprogrammet/db/testing`) |
| Data | deterministic fake data, generated: 5 departments, 20 fields of study, 3000 persons, 23 teams, 780 memberships (282 active in Høst 2026; terms Vår 2018 to Høst 2026), `ANALYZE`d (`spike/seed.ts`) |
| Relations | `spike/relations.ts`: `team`, `membership`, `person`, `position`, `fieldOfStudy`, `department`, `adminGrant` over the existing `src/schema.ts` (91 lines) |
| Handles | the repositories' unchanged `Drizzle`, and a second handle `Rqb` built with `{ relations }` on the same `SqlClient`; one handle also served `select`, `insert` and `query` in one transaction |
| Reads compared | the team page (`TeamRepository.findById` + `MembershipRepository.listByTeam`) and the people list with current memberships (`PersonRepository.list(null)` + `MembershipRepository.activeIn(semester)`, joined in memory), plus `activeIn` itself; each against the RQB version, both decoded with the domain Schemas (`Team`, `Person`, `Membership`, the repository's view schemas) |

Run: `SPIKE_TARGET=pglite|postgres SPIKE_SCENARIO=report|behaviour|readonly|strategy bun spike/run.ts` from `packages/db` inside `devenv shell`.

Timings come from a loaded workstation (load average 6 to 8 from sibling agents): read them as ratios, not absolutes. Each is the p50 of 100 to 300 runs after 20 warm-ups, over three runs per build.

## Result equality

| Check | PGlite | PostgreSQL | Both builds |
| --- | --- | --- | --- |
| Team page, all 23 teams (780 memberships), `isDeepStrictEqual` after decoding | equal | equal | yes |
| People list with current memberships (3000 persons, 282 active memberships) | equal | equal | yes |
| `activeIn` against RQB from the membership side (282 rows) | equal | equal | yes |

Two shaping steps stay in TypeScript, as today: `termOf` (columns → `start`/`end` semesters), and a sort. RQB's `orderBy` names only the queried table's own columns, so `ORDER BY team.name, person.name, id` of `activeIn` is restored in memory.

## Generated SQL and statement counts

Current team page (2 statements):

```sql
select "active", "default_term", "department_id", "function", "id", "name" from "team" where "team"."id" = $1
select "membership"."end_term", …, "person"."name", "position"."name" from "membership"
  inner join "person" on "membership"."person_id" = "person"."id"
  inner join "position" on "membership"."position_id" = "position"."id"
  where "membership"."team_id" = $1 order by "membership"."start_ordinal" asc, "membership"."id" asc
```

RQB team page (1 statement, pinned build; `params=[1,1,1,1]`, the `limit`s of the one-relations and the id):

```sql
select "d0"."active" as "active", …, "d0"."name" as "name", "memberships"."r" as "memberships"
from "team" as "d0"
left join lateral(select coalesce(json_agg(row_to_json("t".*)), '[]') as "r" from (
  select "d1"."end_term" as "endTerm", …, "person"."r" as "person", "position"."r" as "position"
  from "membership" as "d1"
  left join lateral(select row_to_json("t".*) "r" from (select "d2"."name" as "name" from "person" as "d2" where "d1"."person_id" = "d2"."id" limit $1) as "t") as "person" on true
  left join lateral(select row_to_json("t".*) "r" from (select "d2"."name" as "name" from "position" as "d2" where "d1"."position_id" = "d2"."id" limit $2) as "t") as "position" on true
  where "d0"."id" = "d1"."team_id" order by "d1"."start_ordinal" asc, "d1"."id" asc) as "t") as "memberships" on true
where "d0"."id" = $3 limit $4
```

RQB people list (1 statement): a lateral subquery per person for the field of study and one for the person's active memberships (`where "d1"."end_ordinal" >= $4 and "d1"."start_ordinal" <= $5`), each membership with its own position and team laterals.

Statement counts: team page 2 → 1; people list 2 → 1. The web `teamView` makes about six repository reads (team, department names, current semester, memberships, positions, the department's people for the add control): RQB would merge two of them.

## Plans (`EXPLAIN (ANALYZE, BUFFERS)`, PostgreSQL 18.6, 3000 persons)

| Statement | Planning | Execution | Notes |
| --- | --- | --- | --- |
| Team page, current [1] team | 0.03 ms | 0.01 ms | seq scan, 23 rows |
| Team page, current [2] memberships | 0.21 ms | 0.49 ms | `membership_no_overlap` index for `team_id`, hash join with a 3000-row `person` seq scan, 46 buffers |
| **Team page, RQB** | 0.16 ms | **0.27 ms** | nested loops: bitmap scan of `membership_no_overlap`, `person_pkey` index scan ×34, memoized `position`; 122 buffers |
| People, current [1] | 0.08 ms | 1.72 ms | hash join person ↔ field_of_study, sort |
| People, current [2] `activeIn` | 0.18 ms | 0.83 ms | 282 rows, hash joins |
| **People, RQB** | 0.16 ms | **14.8 ms** | 3000 loops of an aggregate lateral: `membership_no_overlap` index scan with 3000 searches (6104 buffers) for 282 matching rows, 6716 buffers in all |
| `activeIn`, current | 0.41 ms | 1.20 ms |  |
| `activeIn`, RQB from membership | 0.21 ms | 1.12 ms | 879 buffers against 38, filter on the generated ordinals |

The final rc.5 build gives the same plans: team page 0.22 ms against 0.43 ms current, people 12.6 ms against 2.0 ms current, `activeIn` 0.85 ms against 0.76 ms.

### End-to-end timings (effect pipeline including decode; p50 of three runs)

| Read | Current | RQB (pinned) | Current | RQB (rc.5) |
| --- | --- | --- | --- | --- |
| Team page (busiest team, 34 memberships) | 0.97 ms | 0.78 ms | 0.94 ms | 0.70 ms |
| People list with current memberships | 8.1 ms | 23.4 ms | 7.9 ms | 21.8 ms |
| `activeIn` (282 rows) | 2.2 ms | 2.6 ms | 2.3 ms | 2.5 ms |

PGlite shows the same shape (team page 1.4 → 1.0 ms; people list 20 → 42 ms; `activeIn` 5.0 → 5.3 to 7.8 ms).

Why the people list loses: RQB v2 builds a `LEFT JOIN LATERAL` per relation per root row, so 3000 persons run 3000 aggregates although only 282 memberships are active, and every person row carries `"memberships": []`. A membership-side query (`db.query.membership.findMany({ where: active, with: { person, team, position } })`) removes that cost and lands within 0.4 ms of the current query (2.6 against 2.2 ms), but then it is `activeIn` again.

## Behaviour checks

All checks ran on PGlite and on PostgreSQL, on the pinned build and on rc.5, except three that ran on PostgreSQL only: the second-connection check (PGlite has one connection), the SELECT-only role, and the single-handle check.

| Check | Result |
| --- | --- |
| Inside `SqlClient.withTransaction`, a team inserted through the repository's `Drizzle` is visible to `db.query` | yes; a second connection sees 0 rows before commit (PostgreSQL only: PGlite has one connection) |
| After the transaction fails, `db.query` finds nothing | yes (rolled back) |
| `rqb.transaction(tx => tx.query…)` inside `withTransaction` sees the outer write; an inner failure rolls back only the inner savepoint, the outer write survives, the outer failure rolls everything back | yes |
| One handle built with `{ relations }` serves `insert().returning()`, `select()` and `query` in one transaction | yes |
| Reads under the SELECT-only role (`@vektorprogrammet/db/testing/read-only-role`): the team page, the people list and `activeIn`, current and RQB, all 23 teams | succeed with equal results; a write through that role fails with SQLSTATE `42501` `permission denied for table position`. RQB emits `select` only, so it writes nothing (register each new RQB path in `apps/web/test/readsNeverWrite.postgres.test.ts` like any `runQuery` path) |
| `findFirst` with no row | `undefined` (maps to `NotFound` as `findById` does today) |
| Relation filters: `where: { fieldOfStudy: { departmentId: 3 } }`, `where: { memberships: { personId } }` | one statement, `where exists (select * from …)`; 600 persons for department 3 |
| `limit`/`offset`/`orderBy` at the root and nested `limit` | work; see the strategy section for how rc.5 wraps the root |
| `timestamptz` through RQB's JSON (`admin_grant.until`, `mode: "date"`) | arrives as `Date`, as through `select()`; a `Date` filter (`until: { gt }`) works |
| Two foreign keys to `person` (`admin_grant.person_id`, `granted_by`) | needs `alias` on both relations (`grantee`, `granter`); then `with: { grantee, granter }` returns both names |
| Error channel | a refused statement is `EffectDrizzleQueryError` in the typed error channel, the same class `select()` gives (see Failures) |
| `drizzle-kit generate` (pinned kit) after adding the relations module | `No schema changes, nothing to migrate`: relations are not DDL and live outside `schema.ts` |

### Generated columns and the exclusion-constraint table

`membership.start_ordinal` and `end_ordinal` (`generatedAlwaysAs`) are:

- **selectable**: `findMany` returns them unless `columns: { startOrdinal: false, endOrdinal: false }`;
- **filterable**: `where: { startOrdinal: { lte: 4053 }, endOrdinal: { gte: 4053 } }` produced the same 282 rows as `activeIn`;
- **orderable**, also inside a nested relation (`orderBy: { startOrdinal: "asc", id: "asc" }`);
- **typed `number | null`**, because the schema does not mark them `.notNull()`: `const start: number = row.startOrdinal` fails with `Type 'number | null' is not assignable to type 'number'.` The repositories never read them into TypeScript, so this is new. `optional: false` relations (`membership.person`, `.team`, `.position`) are typed non-nullable, as intended.

`membership_no_overlap` (the `EXCLUDE USING gist`) is invisible to Drizzle and to RQB. It does not change any read. PostgreSQL uses its GiST index (it starts with `person_id`, `team_id`) for `team_id` lookups: the plans above show `Bitmap Index Scan on membership_no_overlap` where `membership_team_idx` could serve.

## Failures, with exact text

1. `where: { id: undefined }` and `where: undefined` (our `list(departmentId | null)` idiom) are refused **at runtime as a defect** (`Die`, no statement sent), on the pinned build and on rc.5:

   ```text
   Error: Unexpected 'undefined' in filter value. Use 'EmptyFilter' if you want the filter field to be skipped.
   ```

   and `where: { OR: [] }`:

   ```text
   Error: Unexpected empty array in filters' 'OR' section. Omit field or use 'EmptyFilter' if you want filter to be skipped.
   ```

   `where: { id: EmptyFilter }` returns all 23 rows; `where: { id: { in: [] } }` returns none with `where 1 = 0`. Under this repository's `exactOptionalPropertyTypes` the compiler rejects the `undefined` forms first (`TS2322` for `{ id: undefined }`, `TS2379` for `{ where: undefined }`), so the runtime throw is the backstop. A conditional filter becomes `departmentId === null ? {} : { departmentId }` (omit the key) or `EmptyFilter`.

2. A statement the database refuses, `person.findMany({ columns: { id: true, name: true }, limit: 1 })` after a column rename in the transaction, fails in the typed channel as `EffectDrizzleQueryError`, identical in class to `db.select().from(person).limit(1)`:

   ```text
   pinned: EffectDrizzleQueryError: Failed query: select "d0"."id" as "id", "d0"."name" as "name" from "person" as "d0" limit $1
           params: 1
   rc.5:   EffectDrizzleQueryError: Failed query: select "d0"."id" as "id", "d0"."name" as "name" from "person" as "d0" limit $1
   ```

   (the underlying `SqlError` was SQLSTATE `25P02`, the aborted transaction left by the first failing statement of the probe.)

3. Type probe: `Type 'number | null' is not assignable to type 'number'.` for both generated columns (above).

4. **Final rc.5 only**: `tsc -p packages/db/tsconfig.json` on the scratch copy has one new error, in the repository's own PGlite test layer, with no spike code involved:

   ```text
   test/support/database.ts(30,3): error TS2379: Argument of type 'Effect<EffectPgDatabase<EmptyRelations> & { $client: PgliteClient; }, never, PgliteClient>' is not assignable to parameter of type 'Effect<EffectPgDatabase<EmptyRelations>, never, PgliteClient>' with 'exactOptionalPropertyTypes: true'.
   ```

   (`_.session.transaction` tx types differ: `PgEffectTransaction` of PGlite against effect-postgres.) The pinned build type-checks it. Runtime is fine on both. I messaged `ReimaginedEffect406`, the agent that moves the pin, with this error text.

5. On the pinned build `strategy` is not in the query config type (`TS2379` on the object that carries it) and is ignored at runtime.

No other failure occurred: no RQB call failed on either driver, on either build.

## Differences between the pinned build and final rc.5

Every equality, transaction, role and filter result above is the same on both builds. What differs:

| Area | Pinned `1.0.0-rc.5-5935859` | Final `1.0.0-rc.5` |
| --- | --- | --- |
| `strategy` query option | absent; ignored | `'optimized'` (default) or `'basic'` at the root of a query |
| Paginated or relation-filtered nested read | root table and every lateral built the same way | `optimized` wraps the root in `(select d0.* … order by … limit … offset …) as d0` before the laterals, and `limit` binds in the subquery |
| Enum columns in SQL | `"d0"."function"` | `"d0"."function"::text`; for `select()` too (`"membership"."end_term"::text`); results unchanged |
| `EffectDrizzleQueryError.params` | in the message (`params: 1`) and the field | `UndefinedOr`; omitted by default (`paramsInErrors`) |
| `undefined` in `where` | throws | throws (same text) |
| Plans and results | equal | equal for every read compared |
| Type check of `test/support/database.ts` | passes | fails (TS2379 above) |

The `strategy` default matters only for a paginated nested read. `person.findMany({ where: { fieldOfStudy: { departmentId: 3 } }, orderBy, limit: 50, offset: 100, with: { memberships: { …, with: { team } } } })` (`spike/reads.ts` `peoplePageRqb`, p50 of 100 runs, execution time from `EXPLAIN`):

| Build, strategy | SQL shape | End to end | `EXPLAIN` execution |
| --- | --- | --- | --- |
| rc.5 `optimized` (default) | root in a limited subquery, then laterals | 1.0 ms | 0.62 ms |
| rc.5 `basic` | laterals per person, then limit | 3.5 ms | 2.35 ms |
| pinned (any strategy value) | same as `basic` | 3.3 ms | 2.25 ms |

For the non-paginated team page, people list and `activeIn`, rc.5's SQL is character-for-character the pinned SQL (apart from the enum casts), and `basic` against `optimized` gives identical SQL and results.

## Generating the relations

**Yes, and the kernel is the right source, but only once it declares relationships.** Today `packages/domain/src/kernel/` declares commands, grants, machines, principals and guards. It has no `Entity` or `Relationship`. ADR 0009 says the kernel will use effx spec 0031's names, and that spec (`docs/specs/0031-domain-model-extension.md`, in the effx repository) defines `Relationship` as _from, to, verb, inverse verb, multiplicity `{must|may} × {one|many}`, arc group_, which it already maps to "FK + NOT NULL + UNIQUE". That is the information `defineRelations` needs:

| Spec 0031 `Relationship` | `defineRelations` |
| --- | --- |
| from, to, `must` ⇒ `optional: false`, `may` ⇒ `optional: true` | `r.one.<to>({ from, to, optional })` |
| inverse verb, `many` | `r.many.<from>({ from, to })` on the other table |
| the relationship's identity | `alias` where two relationships join the same pair (`admin_grant` → `person` twice) |

Three recommendations:

1. Do not hand-write `defineRelations` for the whole schema. If a read adopts RQB before the kernel has `Relationship`, a generator over `getTableConfig(table).foreignKeys` is feasible: it lists all 12 foreign keys with `notNull` (listed by `spike/foreignKeys.ts`). It gives the `one` side exactly and a `many` side by a naming rule, but the names of the two directions and the `alias` for the `admin_grant` pair cannot come from a foreign key, so those would be a second, hand-kept table. That is a convention, not a derivation.
2. When the kernel declares `Relationship`, emit three things from it: the foreign key in `schema.ts` (or a test that `schema.ts` agrees), the Alloy sig multiplicities, and `defineRelations`. Test (the second rung of the derivation ladder) that the emitted relations and the schema's foreign keys agree until generation closes the loop.
3. The kernel cannot express what the spike found missing: the `EXCLUDE` constraint, the generated ordinal columns and their `NOT NULL`. Mark the ordinals `.notNull()` in `schema.ts` (the migration changes `ALTER COLUMN … SET NOT NULL` on a generated column; check `drizzle-kit generate` output before adopting) so a generated or hand-written read gets `number`.

## What adopting would change in the code

| Where | Change |
| --- | --- |
| `packages/db/src/relations.ts` | the generated relations module (91 lines for seven tables with their aliases when hand-written, as in the spike) |
| `internal/drizzle.ts` | `Drizzle` becomes `Context.Service<Drizzle, EffectPgDatabase<typeof relations>>`; `layerPg` is `PgDrizzle.makeWithDefaults({ relations })`; a handle built that way did every operation here |
| `test/support/database.ts` | the PGlite layer builds with `{ relations }`; on rc.5 it also needs the assignability fix above |
| Repositories | a nested read becomes one `db.query.<table>.findMany`; the existing joins stay where they are cheaper (the people list, `activeIn`); conditional filters stop passing `undefined` |
| Decoding | unchanged in kind: RQB rows still go through the domain Schemas; `termOf` stays |
| Tests | the read-path registry in `apps/web/test/readsNeverWrite.postgres.test.ts` lists each new path; an equality test between the join and RQB versions (what `spike/compare.ts` does) while both exist |

## Not run

- **Effect 4.0.6.** This worktree stays on Effect 4.0.5; the Effect-line move belongs to another agent. The result that RQB works over `@effect/sql-pg` and `@effect/sql-pglite` 4.0.5 on both Drizzle builds does not say anything about 4.0.6.
- **Neon through Hyperdrive and the Worker runtime (workerd).** Round-trip savings and plans on Neon's statistics are `[INFERENCE]`; only local PostgreSQL 18.6 and PGlite ran.
- **Production-shaped data.** The data is deterministic fake data at production volume, in cache, with 282 active memberships; cold-cache and skewed distributions were not tried.
- **Concurrency and pool pressure**, and RQB `extras`, aggregates, `$count`, many-to-many `through`, views, and the cache (`withCache`; the repository runs no Drizzle cache).
- **On rc.5:** `paramsInErrors: true`, the JSON parameter serialisation fix, `getTableUniqueName` and the view exports changes (none touch RQB reads here); `drizzle-kit` rc.5 (only the pinned kit's `generate` ran).
- **The repository's gates** (`vp check`, `vp run -r test`, `bun run ready`): the spike is excluded from lint and format and was run with `bun`; `tsc -p packages/db/tsconfig.spike.json` was run for type findings and its remaining errors are the intended ones above plus the spike's own union typing in `compare.ts`.

## Reproduce

```sh
devenv up -d
devenv shell -- bun install
cd packages/db
SPIKE_TARGET=postgres SPIKE_SCENARIO=report   devenv shell -- bun spike/run.ts   # equality, SQL, timings, EXPLAIN, payload
SPIKE_TARGET=postgres SPIKE_SCENARIO=behaviour devenv shell -- bun spike/run.ts  # transactions, filters, errors
SPIKE_TARGET=postgres SPIKE_SCENARIO=readonly devenv shell -- bun spike/run.ts   # SELECT-only role
SPIKE_TARGET=postgres SPIKE_SCENARIO=strategy devenv shell -- bun spike/run.ts   # basic vs optimized (rc.5)
SPIKE_TARGET=pglite   SPIKE_SCENARIO=report   devenv shell -- bun spike/run.ts
# final rc.5: from the repository root, then run the same commands in packages/db-rc5
devenv shell -- sh packages/db/spike/rc5-scratch.sh
devenv down
```

| File | What it holds |
| --- | --- |
| `spike/relations.ts` | the `defineRelations` module |
| `spike/harness.ts` | the two handles on one `SqlClient`, the statement recorder, the PGlite and PostgreSQL environments |
| `spike/seed.ts` | production-volume fake data |
| `spike/reads.ts` | the current and RQB versions of each read, with their decoding |
| `spike/compare.ts` | equality, statements, timings, plans, payload, strategies |
| `spike/behaviour.ts` | transactions, filters, aliases, timestamps, errors, the role probe |
| `spike/types.ts`, `spike/foreignKeys.ts` | the generated-column type probe; the foreign keys the schema declares |
