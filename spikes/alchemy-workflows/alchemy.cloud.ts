/**
 * The stack of the cloud run: the same Worker, Workflow and Hyperdrive configuration as `alchemy.run.ts`, deployed to
 * Cloudflare for one short run, with the origin of the Hyperdrive configuration the throwaway Neon branch of that run.
 * It deploys only with operator authority and is torn down in the same run (`scripts/with-neon-branch.sh` and the
 * `cloud:*` scripts of `package.json`).
 *
 * ```
 * Worker vp-spike-workflows (no workers.dev URL) ── Workflow vp-spike-workflows-renewal
 *   └─ Hyperdrive vp-spike-workflows-neon (caching off) ──▶ Neon branch, role vp_app
 * ```
 *
 * Every resource carries the `vp-spike-workflows` prefix, so that the teardown removes exactly these and nothing else in
 * the account. State is Alchemy's Cloudflare state store, which encrypts each document at rest: the Hyperdrive origin's
 * password is written into it, so a local state file (`Alchemy.localState()`) would hold it in plain text.
 *
 * The Neon values are read HERE, in the stack's scope (`NEON_*` from `with-neon-branch.sh`, the password from
 * SecretSpec), and reach only the Hyperdrive resource. The Worker's Init reads no `Config`: Alchemy would bind every
 * value it read onto the deployed Worker as a secret (`src/deployment.ts`).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import { SpikeDeployment } from "./src/deployment.ts";
import { cloudDeployment } from "./src/deployments.ts";
import { WORKER_NAME, WORKFLOW_NAME } from "./src/names.ts";
import RenewalWorker from "./src/renewalWorker.ts";

export default Alchemy.Stack(
  WORKER_NAME,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* stack() {
    const deployment = yield* cloudDeployment;

    yield* RenewalWorker.pipe(
      Effect.provideService(SpikeDeployment, deployment)
    );

    return { worker: WORKER_NAME, workflow: WORKFLOW_NAME };
  })
);
