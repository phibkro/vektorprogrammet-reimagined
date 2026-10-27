/**
 * What the stack tells the Worker about where it runs, as a service that the STACK provides around the Worker: the
 * target (`local` for `alchemy dev`, `cloud` for the deployed run) and the Hyperdrive origin.
 *
 * Why a service and not `Config`: Alchemy intercepts every `Config` lookup during a Worker's Init and binds the value
 * onto the deployed Worker as a secret (`Platform.ts`, `Runtime.ts` `reifyBoundConfigProvider`); in the first local runs
 * `DATABASE_URL` and `USER` became bindings that way. The Worker needs neither, so nothing in its Init reads `Config`.
 * The stack reads its configuration in its own scope (`deployments.ts`), outside that interception, and the origin,
 * password included, reaches only the Hyperdrive resource. In the deployed Worker's runtime the service is absent and
 * nothing needs it: `Hyperdrive.Connect` reads the binding by the resource's logical id.
 */
import { Context } from "effect";
import type { Redacted } from "effect";

export interface HyperdriveOriginSettings {
  readonly database: string;
  readonly host: string;
  readonly password: Redacted.Redacted;
  readonly port?: number;
  readonly scheme: "postgres";
  readonly user: string;
}

export interface Deployment {
  readonly origin: HyperdriveOriginSettings;
  readonly target: "cloud" | "local";
}

export class SpikeDeployment extends Context.Service<
  SpikeDeployment,
  Deployment
>()("spike/Deployment") {}
