/**
 * A SELECT-only role on the disposable database (spec 0003, falsifier 3: "reads never write").
 *
 * `readOnlyRole` needs `TestDatabaseUrl` (`disposableDatabase.ts`) and provides `ReadOnlyDatabaseUrl`: the URL
 * of a login role that may connect and `SELECT` from every table, and nothing else: no INSERT, UPDATE,
 * DELETE or TRUNCATE, no sequence use, no temporary tables, no `CREATE`. Code that runs through it and
 * succeeds therefore wrote nothing. A write is refused with `permission denied` (SQLSTATE 42501), which
 * `DatabaseLive` turns into a defect.
 *
 * The role is cluster-wide, so release drops what it owns and then the role itself, before the database is
 * dropped. It needs a `TEST_DATABASE_ADMIN_URL` role that may create roles (devenv's is a superuser).
 */
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, Random, Redacted } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";

import { TestDatabaseUrl } from "./disposableDatabase.ts";

/** The URL of a role on the disposable database that holds SELECT and nothing else. */
export class ReadOnlyDatabaseUrl extends Context.Service<
  ReadOnlyDatabaseUrl,
  Redacted.Redacted
>()("test/ReadOnlyDatabaseUrl") {}

const randomWord = Effect.map(Random.nextIntBetween(0, 2 ** 31), (n) =>
  n.toString(36)
);

export const readOnlyRole = Layer.effect(
  ReadOnlyDatabaseUrl,
  Effect.gen(function* readOnlyRole() {
    const database = yield* TestDatabaseUrl;
    const client = yield* PgClient.make({ maxConnections: 1, url: database });
    const url = new URL(Redacted.value(database));
    const databaseName = url.pathname.slice(1);
    const role = `vp_read_only_${yield* randomWord}`;
    const password = `${yield* randomWord}${yield* randomWord}`;

    yield* Effect.acquireRelease(
      Effect.forEach(
        [
          `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`,
          `revoke temporary on database "${databaseName}" from public`,
          `grant connect on database "${databaseName}" to "${role}"`,
          `grant usage on schema public to "${role}"`,
          `grant select on all tables in schema public to "${role}"`,
        ],
        (statement) => client.unsafe(statement),
        { discard: true }
      ),
      () =>
        client
          .unsafe(`drop owned by "${role}"`)
          .pipe(
            Effect.andThen(client.unsafe(`drop role if exists "${role}"`)),
            Effect.orDie
          )
    );

    url.username = role;
    url.password = password;

    return Redacted.make(url.toString());
  }).pipe(Effect.orDie)
).pipe(Layer.provide(Reactivity.layer));
