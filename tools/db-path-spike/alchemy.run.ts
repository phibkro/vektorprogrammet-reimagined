/**
 * Infrastructure for slice 0000, the database-path spike (Alchemy v2).
 * Deploy only with operator authority; see README.md for the exact commands.
 *
 * Every resource carries the `vp-spike-0000` prefix, so the teardown removes
 * exactly these and nothing else in the account.
 *
 * The Hyperdrive origin password is `NEON_APP_PASSWORD` (SecretSpec) read through
 * `Config.Redacted`. Alchemy writes a `Redacted` input into its state document as a
 * plain string (`State/StateEncoding.ts`); the Cloudflare state store encrypts each
 * document at rest (AES-CTR, key in the account's Secrets Store; `Cloudflare/StateStore/Store.ts`).
 * So the value never lands in the repository, in a log, or in plain text in state.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import {
  COMPATIBILITY_DATE,
  COMPATIBILITY_FLAGS,
  neonOrigin,
} from "../../apps/web/worker.config.ts";

const PREFIX = "vp-spike-0000";

const spike = Effect.gen(function* spike() {
  // Neon `dev` through Hyperdrive as role `vp_app`. Caching is OFF (architecture §4).
  const database = yield* Cloudflare.Hyperdrive.Connection("Database", {
    caching: { disabled: true },
    name: `${PREFIX}-neon-dev`,
    origin: yield* neonOrigin,
  });

  return yield* Cloudflare.Worker("Worker", {
    compatibility: { date: COMPATIBILITY_DATE, flags: COMPATIBILITY_FLAGS },
    env: {
      CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
      HYPERDRIVE: database,
    },
    main: "./src/worker.ts",
    name: PREFIX,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  });
});

export default Alchemy.Stack(
  PREFIX,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.map(spike, (worker) => ({ url: worker.url }))
);
