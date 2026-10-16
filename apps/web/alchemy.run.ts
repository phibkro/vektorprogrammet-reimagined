/**
 * Infrastructure for `apps/web` (Alchemy v2, the single infrastructure root).
 * DO NOT RUN without operator authority: `alchemy deploy` creates and changes
 * Cloudflare resources. Stage `production` is the production deployment;
 * every other stage is a `preview`. Local development does not use this file
 * (see README: `vp dev` with `DATABASE_URL`).
 *
 * Secrets and connection details are env-var placeholders read at deploy time
 * (never committed): NEON_HOST, NEON_DATABASE, NEON_USER, NEON_PASSWORD,
 * TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, and for production only MAIL_FROM
 * and SLACK_WEBHOOK_URL.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";

import type { WorkerEnv } from "./src/server/env";
import {
  COMPATIBILITY_DATE,
  COMPATIBILITY_FLAGS,
  CONTACT_RATE_LIMIT,
  OUTBOX_SWEEP_CRON,
  PUBLIC_FILES_BUCKET,
  WORKER_MAIN,
} from "./worker.config";

const web = Effect.gen(function* web() {
  const stage = yield* Alchemy.Stage;
  const deployment = stage === "production" ? "production" : "preview";

  // Neon through Hyperdrive. Query caching is OFF: Hyperdrive does not invalidate
  // cached reads on writes, so a cached read after a write would be a bug.
  const database = yield* Cloudflare.Hyperdrive.Connection("Database", {
    caching: { disabled: true },
    origin: {
      database: yield* Config.NonEmptyString("NEON_DATABASE"),
      host: yield* Config.NonEmptyString("NEON_HOST"),
      password: yield* Config.Redacted("NEON_PASSWORD"),
      scheme: "postgres",
      user: yield* Config.NonEmptyString("NEON_USER"),
    },
  });

  // Public files: EU jurisdiction, no public r2.dev access; read only through /filer/{key}.
  const publicFiles = yield* Cloudflare.R2.Bucket("PublicFiles", {
    jurisdiction: "eu",
    name: PUBLIC_FILES_BUCKET,
    publicAccess: false,
  });

  const common = {
    CONTACT_RATE_LIMIT: Cloudflare.RateLimit("CONTACT_RATE_LIMIT", {
      namespaceId: CONTACT_RATE_LIMIT.namespaceId,
      simple: {
        limit: CONTACT_RATE_LIMIT.limit,
        period: CONTACT_RATE_LIMIT.period,
      },
    }),
    DEPLOYMENT: deployment,
    HYPERDRIVE: database,
    PUBLIC_FILES: publicFiles,
    TURNSTILE_SECRET_KEY: Config.Redacted("TURNSTILE_SECRET_KEY"),
    TURNSTILE_SITE_KEY: yield* Config.NonEmptyString("TURNSTILE_SITE_KEY"),
  };

  // Only production binds the real mail and Slack transports; a preview has no
  // send_email binding at all, and its runtime builds the capture sink.
  const mailFrom =
    deployment === "production"
      ? yield* Config.NonEmptyString("MAIL_FROM")
      : null;

  const env =
    mailFrom === null
      ? common
      : {
          ...common,
          MAIL_FROM: mailFrom,
          SEND_EMAIL: yield* Cloudflare.Email.SendEmail("SEND_EMAIL", {
            allowedSenderAddresses: [mailFrom],
          }),
          SLACK_WEBHOOK_URL: Config.Redacted("SLACK_WEBHOOK_URL"),
        };

  return yield* Cloudflare.Website.Vite("Web", {
    compatibility: { date: COMPATIBILITY_DATE, flags: COMPATIBILITY_FLAGS },
    crons: [OUTBOX_SWEEP_CRON],
    env,
    main: WORKER_MAIN,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  });
});

/**
 * Compile-time check that the bindings declared here are the ones the Worker
 * reads (`src/server/env.ts`): a renamed or missing binding fails the type check.
 */
type DeclaredEnv = Cloudflare.InferEnv<typeof web>;

export type BindingsMatchWorkerEnv = DeclaredEnv extends WorkerEnv
  ? true
  : never;

const bindingsMatch: BindingsMatchWorkerEnv = true;

export default Alchemy.Stack(
  "vektorprogrammet",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.map(web, (worker) => ({ bindingsMatch, url: worker.url }))
);
