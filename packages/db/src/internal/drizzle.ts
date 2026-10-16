/**
 * The Drizzle database the repositories query through. Internal: the package
 * root exposes only `DatabaseLive`, which builds it on `@effect/sql-pg`.
 * Tests build it on `@effect/sql-pglite` instead (`drizzle-orm/effect-pglite`).
 *
 * Drizzle's sessions run every statement through the ambient `SqlClient`, so
 * a statement issued inside `SqlClient.withTransaction` joins that transaction.
 */
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Schema } from "effect";
import type * as Option from "effect/Option";

export class Drizzle extends Context.Service<
  Drizzle,
  PgDrizzle.EffectPgDatabase
>()("@vektorprogrammet/db/Drizzle") {
  /** Drizzle `effect-postgres` over the `PgClient` in context (no Drizzle logger or cache). */
  static readonly layerPg = Layer.effect(Drizzle, PgDrizzle.makeWithDefaults());
}

/**
 * A row decoder for repository reads. Stored data that violates the domain
 * schema is a defect (a repair alarm), never "not found".
 */
export const decodeWith = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownEffect(schema);

  return (row: unknown): Effect.Effect<A> => Effect.orDie(decode(row));
};

/** The first decoded row as an option; a missing row is absence, while a bad row remains a defect. */
export const decodeFirstOption =
  <A>(decode: (row: unknown) => Effect.Effect<A>) =>
  (rows: readonly unknown[]): Effect.Effect<Option.Option<A>> => {
    const [row] = rows;

    return row === undefined ? Effect.succeedNone : Effect.asSome(decode(row));
  };

/** The first row a statement returned; a missing row here is a broken invariant (defect). */
export const single = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;

  return row === undefined
    ? Effect.die("expected the statement to return a row")
    : Effect.succeed(row);
};
