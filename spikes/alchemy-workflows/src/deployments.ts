/**
 * The two deployments that a stack can hand to the Worker (`deployment.ts`), read from the environment in the stack's
 * own scope. Nothing here is imported by the Worker.
 *
 * `local` (`alchemy dev`): `DATABASE_URL`, which devenv sets for its PostgreSQL and which a test sets for its
 * disposable database. A host that is not this machine is refused, so the stack cannot be pointed at a remote database
 * by a stray environment variable.
 *
 * `cloud` (`alchemy deploy`, `alchemy.cloud.ts`): the throwaway Neon branch of the run, as the least-privilege role
 * `vp_app`: the host, database and role from `NEON_HOST`, `NEON_DATABASE` and `NEON_USER`, the password from
 * `NEON_APP_PASSWORD`, read as `Redacted`. These are the variables that `apps/web` reads, and
 * `scripts/with-neon-branch.sh` derives them for the branch.
 */
import { Array as Arr, Config, Effect, Redacted } from "effect";

import type { Deployment } from "./deployment.ts";
import { NonLocalDatabase } from "./errors.ts";

const LOCAL_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

const POSTGRES_PORT = 5432;

export const cloudDeployment = Effect.gen(function* cloudDeployment() {
  return {
    origin: {
      database: yield* Config.NonEmptyString("NEON_DATABASE"),
      host: yield* Config.NonEmptyString("NEON_HOST"),
      password: yield* Config.Redacted("NEON_APP_PASSWORD"),
      scheme: "postgres" as const,
      user: yield* Config.NonEmptyString("NEON_USER"),
    },
    target: "cloud" as const,
  } satisfies Deployment;
});

export const localDeployment = Effect.gen(function* localDeployment() {
  const url = yield* Config.URL("DATABASE_URL");

  if (!Arr.contains(LOCAL_HOSTS, url.hostname)) {
    return yield* Effect.die(new NonLocalDatabase({ host: url.hostname }));
  }

  // devenv's PostgreSQL trusts the local user: its URL names no user, and the role is the operating system's.
  const user =
    url.username === ""
      ? yield* Config.String("PGUSER").pipe(
          Config.orElse(() => Config.String("USER"))
        )
      : decodeURIComponent(url.username);

  return {
    origin: {
      database: decodeURIComponent(url.pathname.slice(1)),
      host: url.hostname,
      password: Redacted.make(decodeURIComponent(url.password)),
      port: url.port === "" ? POSTGRES_PORT : Number(url.port),
      scheme: "postgres" as const,
      user,
    },
    target: "local" as const,
  } satisfies Deployment;
});
