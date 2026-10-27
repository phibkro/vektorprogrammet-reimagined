/**
 * The stack of the spike: one Worker (`src/renewalWorker.ts`) that hosts one Cloudflare Workflow
 * (`src/renewalWorkflow.ts`) and binds one Hyperdrive configuration (`src/database.ts`) to a local PostgreSQL.
 *
 * It runs through `alchemy dev` only, and the stack enforces it: a plan that is not a dev plan dies here, before the
 * Worker, the Workflow or the Hyperdrive configuration is declared, so `alchemy deploy` declares no cloud resource
 * with this stack. Every resource is a local one (workerd, a virtual Hyperdrive, local state under `.alchemy/` in the
 * directory `alchemy dev` runs in).
 *
 * ```
 * devenv shell -- bash -c 'cd spikes/alchemy-workflows && bunx alchemy dev --stage spike'
 * ```
 *
 * `DATABASE_URL` is the one devenv exports for its PostgreSQL, inherited as it is. The stack reads it here, in its own
 * scope, and hands the origin to the Worker as a service (`src/deployment.ts`): the Worker's Init reads no `Config`,
 * because Alchemy would bind every value it read onto the Worker as a secret. Where the local engine keeps its files:
 * `<directory alchemy dev runs in>/.alchemy/local/workflows`. The runtime tests start `alchemy dev` in a directory of
 * their own, so that path is explicit and disposable.
 */
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import { SpikeDeployment } from "./src/deployment.ts";
import { localDeployment } from "./src/deployments.ts";
import { DevOnly } from "./src/errors.ts";
import RenewalWorker from "./src/renewalWorker.ts";

export default Alchemy.Stack(
  "MembershipRenewalSpike",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* stack() {
    const { dev } = yield* AlchemyContext;

    if (!dev) {
      return yield* Effect.die(
        new DevOnly({
          message:
            "spikes/alchemy-workflows runs through `alchemy dev` only; it declares a local database and no deployment",
        })
      );
    }

    const deployment = yield* localDeployment;

    const worker = yield* RenewalWorker.pipe(
      Effect.provideService(SpikeDeployment, deployment)
    );

    return { url: worker.url.as<string>() };
  })
);
