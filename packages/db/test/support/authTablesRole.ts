/**
 * A login role on the disposable database that holds privileges on Better Auth's four tables and on nothing else (spec
 * 0017, falsifier 6: the Better Auth pool reads no domain table).
 *
 * `authTablesRole` needs `TestDatabaseUrl` (`disposableDatabase.ts`) and provides `AuthTablesDatabaseUrl`: the URL of a
 * role that may connect, and `SELECT`, `INSERT`, `UPDATE` and `DELETE` on `auth_user`, `auth_session`, `auth_account` and
 * `auth_verification`. A statement of Better Auth's own `pg` pool that reads `person`, `account` or any other table of
 * the domain is refused with `permission denied` (SQLSTATE 42501). Code that signs people in through this role and
 * succeeds therefore reads the domain only through the application's ports.
 *
 * The role is cluster-wide, so release drops what it owns and then the role itself, before the database is dropped.
 */
import { Array as Arr, Context, Effect, Layer, Random, Redacted } from "effect";

import { TestDatabaseUrl, withClient } from "./disposableDatabase.ts";

/** Better Auth's tables (`modelName` in `apps/web/src/server/auth.ts`), the only ones that its pool may touch. */
export const AUTH_TABLES = [
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
] as const;

/** The URL of a role on the disposable database that holds privileges on `AUTH_TABLES` and on no other table. */
export class AuthTablesDatabaseUrl extends Context.Service<
  AuthTablesDatabaseUrl,
  Redacted.Redacted
>()("test/AuthTablesDatabaseUrl") {}

const randomWord = Effect.map(Random.nextIntBetween(0, 2 ** 31), (n) =>
  n.toString(36)
);

export const authTablesRole = Layer.effect(
  AuthTablesDatabaseUrl,
  Effect.gen(function* authTablesRole() {
    const database = yield* TestDatabaseUrl;
    const url = new URL(Redacted.value(database));
    const databaseName = url.pathname.slice(1);
    const role = `vp_auth_tables_${yield* randomWord}`;
    const password = `${yield* randomWord}${yield* randomWord}`;

    yield* Effect.acquireRelease(
      withClient(database, (client) =>
        Effect.forEach(
          [
            `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`,
            `revoke temporary on database "${databaseName}" from public`,
            `grant connect on database "${databaseName}" to "${role}"`,
            `grant usage on schema public to "${role}"`,
            `grant select, insert, update, delete on ${Arr.join(
              Arr.map(AUTH_TABLES, (table) => `"${table}"`),
              ", "
            )} to "${role}"`,
          ],
          (statement) => client.unsafe(statement),
          { discard: true }
        )
      ),
      () =>
        withClient(database, (client) =>
          client
            .unsafe(`drop owned by "${role}"`)
            .pipe(
              Effect.andThen(client.unsafe(`drop role if exists "${role}"`))
            )
        ).pipe(Effect.orDie)
    );

    url.username = role;
    url.password = password;

    return Redacted.make(url.toString());
  }).pipe(Effect.orDie)
);
