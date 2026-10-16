/**
 * Infrastructure for `apps/web` (Alchemy v2, the single infrastructure root).
 *
 * Three kinds of stage (spec 0002, `docs/specs/0002-worker-previews.md`):
 * - `production`: the production deployment, the only one with real mail, Slack and Turnstile keys.
 * - `main` (`BASE_STAGE`): a long-lived Worker built from `main`, on Neon `dev` with fake data.
 * - any other stage (`pr-<n>`): a Cloudflare Worker Preview of the `main` Worker, on its own Neon
 *   branch. A Preview cannot own crons, so the outbox sweep and the semester job (spec 0003) run on
 *   `main` and `production` only; a Preview's semester rows come from its Neon fork of `dev`.
 *
 * Connection details are env vars read at deploy time (never committed): NEON_HOST, NEON_DATABASE,
 * NEON_USER, NEON_APP_PASSWORD, and for production only TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY,
 * MAIL_FROM and SLACK_WEBHOOK_URL. CI sets them (`.github/workflows/preview.yml`); locally,
 * `tools/with-neon-env.sh app` derives the Neon ones from SecretSpec.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer, Redacted } from "effect";

import type { WorkerEnv } from "./src/server/env";
import {
  BASE_STAGE,
  COMPATIBILITY_DATE,
  COMPATIBILITY_FLAGS,
  CONTACT_RATE_LIMIT,
  OUTBOX_SWEEP_CRON,
  TURNSTILE_TEST_KEYS,
  WORKER_MAIN,
  neonOrigin,
  publicFilesBucket,
} from "./worker.config";

type StageKind = "production" | "base" | "preview";

const stageKind = (stage: string): StageKind => {
  if (stage === "production") {
    return "production";
  }

  return stage === BASE_STAGE ? "base" : "preview";
};

const web = Effect.gen(function* web() {
  const stage = yield* Alchemy.Stage;
  const kind = stageKind(stage);
  // Base and previews are both the `preview` deployment: capture sink, no test actor.
  const deployment = kind === "production" ? "production" : "preview";

  // Neon through Hyperdrive. Query caching is OFF: Hyperdrive does not invalidate
  // cached reads on writes, so a cached read after a write would be a bug.
  const database = yield* Cloudflare.Hyperdrive.Connection("Database", {
    caching: { disabled: true },
    origin: yield* neonOrigin,
  });

  // Public files: EU jurisdiction, no public r2.dev access; read only through /filer/{key}.
  const publicFiles = yield* Cloudflare.R2.Bucket("PublicFiles", {
    jurisdiction: "eu",
    name: publicFilesBucket(stage),
    publicAccess: false,
  });

  const turnstile =
    kind === "production"
      ? {
          secretKey: Config.Redacted("TURNSTILE_SECRET_KEY"),
          siteKey: yield* Config.NonEmptyString("TURNSTILE_SITE_KEY"),
        }
      : {
          secretKey: Redacted.make(TURNSTILE_TEST_KEYS.secretKey),
          siteKey: TURNSTILE_TEST_KEYS.siteKey,
        };

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
    TURNSTILE_SECRET_KEY: turnstile.secretKey,
    TURNSTILE_SITE_KEY: turnstile.siteKey,
  };

  // Only production binds the real mail and Slack transports; base and previews have no
  // send_email binding at all, and their runtime builds the capture sink.
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

  const github = yield* GitHub.GitHubEnv;

  // A Preview belongs to the base Worker's script; the script-level settings (crons) stay on the parent.
  const placement =
    kind === "preview"
      ? {
          preview: {
            message:
              github?.pr === undefined ? `stage ${stage}` : `PR #${github.pr}`,
            of: yield* Cloudflare.Worker.ref("Web", { stage: BASE_STAGE }),
            tag: github?.sha ?? `stage-${stage}`,
          },
        }
      : { crons: [OUTBOX_SWEEP_CRON] };

  const worker = yield* Cloudflare.Website.Vite("Web", {
    compatibility: { date: COMPATIBILITY_DATE, flags: COMPATIBILITY_FLAGS },
    env,
    main: WORKER_MAIN,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
    ...placement,
  });

  // One comment per pull request, updated in place on every push (stable logical id).
  if (github?.pr !== undefined) {
    yield* GitHub.Comment("PreviewComment", {
      body: Output.interpolate`
### Preview

**URL:** ${worker.url}

Built from ${github.sha.slice(0, 7)}. Database: Neon branch \`preview/pr-${github.pr}\` (forked from \`dev\`, fake data only). Updated on every push; removed when the pull request closes.
`,
      issueNumber: github.pr,
      owner: github.owner,
      repository: github.repository,
    });
  }

  return worker;
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
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.map(web, (worker) => ({ bindingsMatch, url: worker.url }))
);
