import {
  Array as Arr,
  Config,
  Context,
  Effect,
  Layer,
  Random,
  Redacted,
} from "effect";

import { provisionRuntimeAccess } from "../../../src/adapters/db/runtimeAccess.ts";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
  withClient,
} from "./disposableDatabase.ts";

/** The restricted login to the same database as TestDatabaseUrl. */
export class RuntimeDatabaseUrl extends Context.Service<
  RuntimeDatabaseUrl,
  Redacted.Redacted
>()("test/RuntimeDatabaseUrl") {}

/** Unique, synthetic-only credentials for an independently provisioned test role. */
export const runtimeRoleCredentials = Effect.gen(
  function* makeRuntimeRoleCredentials() {
    const words = yield* Effect.forEach(Arr.range(0, 7), () =>
      Random.nextIntBetween(0, 2 ** 31)
    );

    const password = Arr.join(
      Arr.map(words, (word) => word.toString(16).padStart(8, "0")),
      ""
    );

    return { password, role: `vektor_runtime_${password.slice(0, 32)}` };
  }
);

/** Creates a unique role and database; the database closes before the cluster-wide role. */
export const runtimeTestDatabase = Layer.effectContext(
  Effect.gen(function* runtimeTestDatabase() {
    const cluster = yield* Config.Redacted("TEST_DATABASE_ADMIN_URL");

    const { role, password } = yield* runtimeRoleCredentials;
    yield* Effect.acquireRelease(Effect.void, () =>
      withClient(cluster, (sql) =>
        sql.unsafe(`drop role if exists "${role}"`)
      ).pipe(Effect.orDie)
    );
    const database = yield* Layer.build(migratedTestDatabase);
    const owner = Context.get(database, TestDatabaseUrl);
    yield* provisionRuntimeAccess(owner, password, role);
    const url = new URL(Redacted.value(owner));
    url.username = role;
    url.password = password;

    return Context.add(
      database,
      RuntimeDatabaseUrl,
      Redacted.make(url.toString())
    );
  }).pipe(Effect.orDie)
);
