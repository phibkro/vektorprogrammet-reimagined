/**
 * The Hyperdrive configuration of the spike, for the target that the stack's `SpikeDeployment` names (`deployment.ts`).
 *
 * `local` (`alchemy dev`): a Hyperdrive resource is virtual, no Cloudflare API is called, and the local runtime's
 * Hyperdrive plugin passes connections through to the `dev` origin (the same origin, without TLS).
 *
 * `cloud` (`alchemy deploy`): a real Hyperdrive configuration under an explicit name, whose origin is the run's
 * throwaway Neon branch. Caching is off: Hyperdrive does not invalidate cached reads on writes.
 *
 * This module runs in the Worker's Init, so it reads no `Config`: everything comes from the stack's service. In the
 * deployed Worker's runtime the service is absent and the props below are never used: the resource is a handle whose
 * logical id names the binding.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Redacted } from "effect";

import { SpikeDeployment } from "./deployment.ts";
import type { Deployment } from "./deployment.ts";
import { HYPERDRIVE_NAME } from "./names.ts";

const RUNTIME_HANDLE: Deployment = {
  origin: {
    database: "-",
    host: "-",
    password: Redacted.make("-"),
    scheme: "postgres",
    user: "-",
  },
  target: "local",
};

export const Database = Effect.gen(function* database() {
  const { origin, target } = Option.getOrElse(
    yield* Effect.serviceOption(SpikeDeployment),
    () => RUNTIME_HANDLE
  );

  if (target === "cloud") {
    return yield* Cloudflare.Hyperdrive.Connection("Database", {
      caching: { disabled: true },
      name: HYPERDRIVE_NAME,
      origin,
    });
  }

  return yield* Cloudflare.Hyperdrive.Connection("Database", {
    caching: { disabled: true },
    dev: { ...origin, sslmode: "disable" },
    origin,
  });
});
