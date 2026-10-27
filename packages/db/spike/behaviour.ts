/** Behaviour checks: transactions, filters, relation filters, the SELECT-only role. */
import { DepartmentId, TeamRepository } from "@vektorprogrammet/domain";
import { EmptyFilter, eq } from "drizzle-orm";
import { Array as Arr, Cause, Console, Effect, Exit, Predicate } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Drizzle } from "../src/internal/drizzle.ts";
import { adminGrant, person, team } from "../src/schema.ts";
import { capture, Rqb } from "./harness.ts";

const describeExit = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? `success ${JSON.stringify(exit.value)?.slice(0, 160)}`
    : `failure: ${Cause.pretty(exit.cause).split("\n").slice(0, 3).join(" | ")} [${Arr.map(exit.cause.reasons, (r) => r._tag).join(",")}]`;

const draft = (name: string) => ({
  defaultTerm: 2 as const,
  departmentId: DepartmentId.make(1),
  function: "other" as const,
  name,
});

/** Does RQB join the ambient transaction, and does its own transaction nest as a savepoint? */
export const transactions = (
  outsideCount: ((name: string) => Effect.Effect<number>) | undefined
) =>
  Effect.gen(function* transactions() {
    const sql = yield* SqlClient;
    const rqb = yield* Rqb;
    const teams = yield* TeamRepository;
    const name = "Spike team in transaction";
    const findByName = rqb.query.team.findFirst({ where: { name } });

    // 1. A row written through the repositories' Drizzle inside `withTransaction` is visible to `db.query`.
    const rolledBack = yield* Effect.exit(
      sql.withTransaction(
        Effect.gen(function* inTx() {
          const created = yield* teams.create(draft(name));
          const seen = yield* findByName;
          yield* Console.log(`inside withTransaction, db.query sees the uncommitted team: ${seen?.id === created.id}`);
          if (outsideCount !== undefined) {
            yield* Console.log(`  a second connection sees ${yield* outsideCount(name)} such teams (0 expected before commit)`);
          }

          return yield* Effect.fail("force rollback");
        })
      )
    );
    yield* Console.log(`  the transaction: ${describeExit(rolledBack)}`);
    yield* Console.log(`after the rollback db.query finds: ${JSON.stringify(yield* findByName)}`);

    // 2. `db.transaction` on the RQB handle (`tx.query`) inside an outer transaction: a savepoint.
    yield* Effect.exit(
      sql.withTransaction(
        Effect.gen(function* outer() {
          yield* teams.create(draft(name));
          const inner = yield* Effect.exit(
            rqb.transaction((tx) =>
              Effect.gen(function* innerTx() {
                const seen = yield* tx.query.team.findFirst({ where: { name } });
                yield* Console.log(`tx.query in db.transaction in withTransaction sees the outer write: ${seen !== undefined}`);

                return yield* Effect.fail("inner rollback");
              })
            )
          );
          yield* Console.log(`  the inner db.transaction: ${describeExit(inner)}`);
          yield* Console.log(`  the outer write survives the inner rollback (savepoint): ${(yield* findByName) !== undefined}`);

          return yield* Effect.fail("outer rollback");
        })
      )
    );
    yield* Console.log(`after the outer rollback db.query finds: ${JSON.stringify(yield* findByName)}`);
  });

/** Filter semantics: `undefined`, `EmptyFilter`, relation filters, limits, absence. */
export const filters = Effect.gen(function* filters() {
  const rqb = yield* Rqb;
  const show = <A, E>(label: string, effect: Effect.Effect<A, E, never>) =>
    capture(Effect.exit(effect)).pipe(
      Effect.flatMap(({ statements, value }) =>
        Console.log(
          `${label}\n    -> ${describeExit(value)}\n    statements sent: ${statements.length}${statements[0] === undefined ? "" : `\n    sql: ${statements[0].sql.slice(0, 500)}`}`
        )
      )
    );

  const count = (rows: readonly unknown[]) => rows.length;

  yield* show("team.findMany({ where: { id: undefined } })", Effect.map(rqb.query.team.findMany({ where: { id: undefined } }), count));
  yield* show("team.findMany({ where: { id: EmptyFilter } })", Effect.map(rqb.query.team.findMany({ where: { id: EmptyFilter } }), count));
  yield* show("team.findMany({ where: undefined })", Effect.map(rqb.query.team.findMany({ where: undefined }), count));
  yield* show("team.findMany({ where: { OR: [] } })", Effect.map(rqb.query.team.findMany({ where: { OR: [] } }), count));
  yield* show("team.findMany({ where: { id: { in: [] } } })", Effect.map(rqb.query.team.findMany({ where: { id: { in: [] } } }), count));
  yield* show("person.findMany({ where: { fieldOfStudy: { departmentId: 3 } } }) (relation filter)", Effect.map(rqb.query.person.findMany({ columns: { id: true }, where: { fieldOfStudy: { departmentId: 3 } } }), count));
  yield* show("team.findMany({ where: { memberships: { personId: 3 } } }) (relation filter on a many)", Effect.map(rqb.query.team.findMany({ columns: { id: true }, where: { memberships: { personId: 3 } } }), count));
  yield* show("team.findMany({ limit: 3, offset: 2, orderBy: { name: desc } })", Effect.map(rqb.query.team.findMany({ columns: { id: true }, limit: 3, offset: 2, orderBy: { name: "desc" } }), (rows) => rows.map((r) => r.id)));
  yield* show("team.findFirst({ where: { id: 99999 } }) (absence)", rqb.query.team.findFirst({ where: { id: 99_999 } }));
  yield* show("team.findMany with memberships { limit: 2 } (nested limit)", rqb.query.team.findMany({ columns: { id: true }, limit: 2, orderBy: { id: "asc" }, with: { memberships: { columns: { id: true }, limit: 2, orderBy: { id: "asc" } } } }));
});

/** The reads under a SELECT-only role: they succeed (so they wrote nothing) while a write is refused. */
export const readOnlyProbe = Effect.gen(function* readOnlyProbe() {
  const sql = yield* SqlClient;
  const write = yield* Effect.exit(sql.unsafe("insert into position (name) values ('Skriveforsøk')"));
  yield* Console.log(`a write through the role: ${describeExit(write)}`);
  const refusal = yield* Effect.flip(sql.unsafe("insert into position (name) values ('Skriveforsøk')"));
  const cause = refusal.reason.cause;
  const detail =
    Predicate.isObject(cause) && "code" in cause && "message" in cause
      ? `code=${String(cause.code)} message=${String(cause.message)}`
      : "unrecognised cause";
  yield* Console.log(`  database refusal: ${detail}`);
});

/** Timestamps through RQB's JSON, aliased relations (two foreign keys to `person`) and the error channel. */
export const adminGrantsAndErrors = Effect.gen(function* adminGrantsAndErrors() {
  const sql = yield* SqlClient;
  const rqb = yield* Rqb;
  yield* sql.unsafe(
    `insert into admin_grant (person_id, granted_by, until) values (1, null, '2099-12-31T23:59:59.123456Z'), (2, 1, '2030-06-01T10:00:00+02:00')`
  );

  const plain = yield* Drizzle;
  const viaSelect = yield* plain.select().from(adminGrant).orderBy(adminGrant.id);
  const viaRqb = yield* rqb.query.adminGrant.findMany({
    orderBy: { id: "asc" },
    with: { grantee: { columns: { name: true } }, granter: { columns: { name: true } } },
  });
  yield* Console.log(
    `select(): until is ${Predicate.isDate(viaSelect[0]?.until) ? "Date" : typeof viaSelect[0]?.until} ${String(viaSelect[0]?.until?.toISOString())}`
  );
  yield* Console.log(
    `RQB     : until is ${Predicate.isDate(viaRqb[0]?.until) ? "Date" : typeof viaRqb[0]?.until} ${String(viaRqb[0]?.until)}`
  );
  yield* Console.log(
    `RQB aliased relations: ${JSON.stringify(Arr.map(viaRqb, (g) => [g.grantee.name, g.granter?.name ?? null]))}`
  );
  const grantees = yield* rqb.query.person.findMany({
    columns: { id: true },
    where: { adminGrants: { until: { gt: new Date("2031-01-01T00:00:00Z") } } },
  });
  yield* Console.log(`person with a grant after 2031 (relation filter on a Date): ${JSON.stringify(grantees)}`);

  // The error channel: a statement the database refuses (the column is gone inside this transaction).
  const failing = yield* Effect.exit(
    sql.withTransaction(
      Effect.gen(function* broken() {
        yield* sql.unsafe("alter table person rename column name to nm");
        yield* Effect.exit(plain.select().from(person).limit(1)).pipe(
          Effect.flatMap((exit) => Console.log(`select() on a broken schema: ${describeExit(exit)}`))
        );
        const exit = yield* Effect.exit(rqb.query.person.findMany({ columns: { id: true, name: true }, limit: 1 }));
        yield* Console.log(`RQB      on a broken schema: ${describeExit(exit)}`);
        const typed = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
        yield* Console.log(`  error channel value tag: ${JSON.stringify(typed)}`);

        return yield* Effect.fail("rollback");
      })
    )
  );
  void failing;
});

/** One handle built with the relations also does everything the repositories do: select, insert, update, delete. */
export const singleHandle = Effect.gen(function* singleHandle() {
  const rqb = yield* Rqb;
  const sql = yield* SqlClient;
  const exit = yield* Effect.exit(
    sql.withTransaction(
      Effect.gen(function* inTx() {
        const [created] = yield* rqb
          .insert(team)
          .values({ defaultTerm: 2, departmentId: 1, function: "other", name: "Single handle team" })
          .returning({ id: team.id });
        const selected = yield* rqb.select({ id: team.id }).from(team).where(eq(team.name, "Single handle team"));
        const viaQuery = yield* rqb.query.team.findFirst({ columns: { id: true }, where: { name: "Single handle team" } });
        yield* Console.log(`insert().returning ${JSON.stringify(created)}; select ${JSON.stringify(selected)}; query ${JSON.stringify(viaQuery)}`);

        return yield* Effect.fail("rollback");
      })
    )
  );
  yield* Console.log(`single handle: ${describeExit(exit)}`);
});
