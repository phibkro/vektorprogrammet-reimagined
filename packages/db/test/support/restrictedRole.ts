/**
 * The construction that `readOnlyRole` and `authTablesRole` share: a login role on the disposable database that may
 * connect and use the `public` schema, plus the one grant that the caller states, and nothing else. Release drops what
 * the role owns and then the role itself; the role is cluster-wide, so that happens before the database is dropped.
 * It needs a `TEST_DATABASE_ADMIN_URL` role that may create roles (devenv's is a superuser).
 */
import { Effect, Random, Redacted } from "effect";

import { TestDatabaseUrl, withClient } from "./disposableDatabase.ts";

const randomWord = Effect.map(Random.nextIntBetween(0, 2 ** 31), (n) =>
  n.toString(36)
);

/**
 * The URL of a new role named `<prefix><random>`. `grant` is the statement that gives it its one privilege, built from
 * the role's name.
 */
export const restrictedRole = (
  prefix: string,
  grant: (role: string) => string
) =>
  Effect.gen(function* createRole() {
    const database = yield* TestDatabaseUrl;
    const url = new URL(Redacted.value(database));
    const databaseName = url.pathname.slice(1);
    const role = `${prefix}${yield* randomWord}`;
    const password = `${yield* randomWord}${yield* randomWord}`;

    yield* Effect.acquireRelease(
      withClient(database, (client) =>
        Effect.forEach(
          [
            `create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`,
            `revoke temporary on database "${databaseName}" from public`,
            `grant connect on database "${databaseName}" to "${role}"`,
            `grant usage on schema public to "${role}"`,
            grant(role),
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
  }).pipe(Effect.orDie);
