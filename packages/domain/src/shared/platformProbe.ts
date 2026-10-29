/**
 * What a deployed platform shows of the properties that the domain needs from it (spec 0025, ADR 0014).
 *
 * The domain declares which checks a platform must show (`PlatformRequirements`, `platformRequirements.ts`); a store
 * adapter runs them on the platform it is on and reports each one as `held` or not, with a detail in the engine's own
 * words. The port reports and a composition root decides what it expects, as `IsolationProbe` does: a platform that is a
 * pooler between the Worker and the database can only be asked from the store itself, through the pooler.
 *
 * The port opens its own transactions and takes none (`TransactionModes`: `Opens`). It writes nothing that a command
 * reads: a probe that writes rolls the write back.
 */
import { Context } from "effect";
import type { Effect } from "effect";

/** One property shown on this platform: `held` says whether it was, `detail` says what was observed. */
export interface PlatformCheckResult {
  readonly id: string;
  readonly held: boolean;
  readonly detail: string;
}

export interface PlatformReport {
  /** The name of the connection profile that the adapter ran with (`hyperdrive`, `direct`): what it was configured for. */
  readonly profile: string;
  readonly checks: readonly PlatformCheckResult[];
}

export class PlatformProbe extends Context.Service<
  PlatformProbe,
  { readonly report: Effect.Effect<PlatformReport> }
>()("@vektorprogrammet/domain/shared/PlatformProbe") {}
