/**
 * Runs a command inside a database transaction and provides the domain's
 * `InTransaction`. The live Layer delegates to `@vektorprogrammet/db`'s
 * `transactional` (the only production provider of `InTransaction`); tests
 * provide their own Layer over in-memory repositories.
 */
import { transactional } from "@vektorprogrammet/db";
import type { InTransaction } from "@vektorprogrammet/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

export class Transactor extends Context.Service<
  Transactor,
  {
    run: <A, E, R>(
      program: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, Exclude<R, InTransaction>>;
  }
>()("@vektorprogrammet/web/server/Transactor") {}

export const transactorLayer: Layer.Layer<
  Transactor,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  Transactor,
  Effect.gen(function* transactorLayer() {
    const sql = yield* SqlClient.SqlClient;

    return Transactor.of({
      run: (program) =>
        transactional(program).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        ),
    });
  })
);
