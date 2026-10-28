/**
 * Infrastructure for `apps/web` and `apps/cms` (Alchemy v2, the single infrastructure root).
 *
 * Two Workers: `Web` (the public site and the control panel, TanStack Start) and `Cms` (EmDash on Astro, headless:
 * its admin and its REST API, no public page; spec 0005). `Web` reads published content from `Cms` over HTTP.
 *
 * Three kinds of stage (spec 0002, `docs/specs/0002-worker-previews.md`):
 * - `production`: the production deployment, the only one with real mail, Slack and Turnstile keys.
 * - `main` (`BASE_STAGE`): long-lived Workers built from `main`, on Neon `dev` with fake data.
 * - any other stage (`pr-<n>`): a Cloudflare Worker Preview of each `main` Worker, on its own Neon
 *   branch. A Preview cannot own crons, so the registered jobs (the outbox sweep, the semester job, the digest, the
 *   alumni consent job, the Workspace sync and the retention run, specs 0003, 0006, 0007b and 0008) run on
 *   `main` and `production` only; a Preview's semester rows come from its Neon fork of `dev`. Nor can it own a queue
 *   consumer, so the outbox queue and its dead-letter queue exist on `main` and `production` only (spec 0008b) and a
 *   Preview delivers its outbox rows in `waitUntil`. A `Web` Preview reads the `Cms` Preview of the same pull request.
 *
 * Connection details are env vars read at deploy time (never committed): NEON_HOST, NEON_DATABASE,
 * NEON_USER, NEON_APP_PASSWORD (the application's role), NEON_EMDASH_USER, NEON_EMDASH_PASSWORD (the
 * CMS's role), EMDASH_ENCRYPTION_KEY and CMS_READ_TOKEN (the `Web` Worker's read-only CMS token), and for
 * production only TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, MAIL_FROM and SLACK_WEBHOOK_URL. CI sets them
 * (`.github/workflows/preview.yml`); locally, `tools/with-neon-env.sh app` derives the Neon ones from SecretSpec.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import { Config, Effect, Layer, Option, Redacted } from "effect";

import type { WorkerEnv } from "./src/server/env";
import {
  BASE_STAGE,
  CMS_COMPATIBILITY_FLAGS,
  COMPATIBILITY_DATE,
  COMPATIBILITY_FLAGS,
  CONTACT_RATE_LIMIT,
  CRON_TRIGGERS,
  DEAD_LETTER_CONSUMER,
  OUTBOX_CONSUMER,
  TURNSTILE_TEST_KEYS,
  WORKER_MAIN,
  WORKER_PLACEMENT,
  cmsMediaBucket,
  emdashOrigin,
  neonOrigin,
  outboxQueuesFor,
  publicFilesBucket,
  stageKind,
} from "./worker.config";

const OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true },
} as const;

/** A Worker's URL for another Worker's env. A Worker with no URL is a fault of the stack, not an empty setting. */
const reachableAt = (worker: {
  readonly url: Output.Output<string | undefined>;
}) =>
  worker.url.pipe(
    Output.mapEffect((url) =>
      url === undefined
        ? Effect.die(
            "the CMS Worker has no URL, so the site cannot read its content"
          )
        : Effect.succeed(url)
    )
  );

/**
 * Where a Worker lives: a Preview belongs to its base stage's Worker script, and the script-level settings
 * (crons and placement) stay on that parent. A Preview does not inherit the parent's placement: Cloudflare sets
 * placement per Preview deployment, and Alchemy's Preview upload sends none, so Previews run at the default
 * placement and are slower to Neon than `main` and `production` (spec 0000c).
 */
const placementOf = (id: "Web" | "Cms", stage: string, crons: string[]) =>
  Effect.gen(function* placeWorker() {
    if (stageKind(stage) !== "preview") {
      return { crons, placement: WORKER_PLACEMENT };
    }

    const github = yield* GitHub.GitHubEnv;

    return {
      preview: {
        message:
          github?.pr === undefined ? `stage ${stage}` : `PR #${github.pr}`,
        of: yield* Cloudflare.Worker.ref(id, { stage: BASE_STAGE }),
        tag: github?.sha ?? `stage-${stage}`,
      },
    };
  });

/**
 * The CMS: EmDash on Astro, built by Alchemy's own Cloudflare adapter over `apps/cms`. Its database is Neon
 * through a Hyperdrive configuration of its own, as the role `emdash_app` that owns the schema `emdash`
 * (`apps/cms/db/emdash-role.sql`); query caching is off because EmDash reads back what it just wrote. Astro's
 * session store (EmDash keeps the signed-in user in it) is a KV namespace Alchemy provisions for the stage.
 */
const cms = Effect.gen(function* deployCms() {
  const stage = yield* Alchemy.Stage;

  const database = yield* Cloudflare.Hyperdrive.Connection("EmdashDatabase", {
    caching: { disabled: true },
    origin: yield* emdashOrigin,
  });

  // Editors' uploads: EU jurisdiction, no public r2.dev access; served by the CMS's own media route.
  const media = yield* Cloudflare.R2.Bucket("Media", {
    jurisdiction: "eu",
    name: cmsMediaBucket(stage),
    publicAccess: false,
  });

  return yield* Cloudflare.Website.Astro("Cms", {
    compatibility: {
      date: COMPATIBILITY_DATE,
      flags: CMS_COMPATIBILITY_FLAGS,
    },
    env: {
      EMDASH_ENCRYPTION_KEY: Config.Redacted("EMDASH_ENCRYPTION_KEY"),
      HYPERDRIVE: database,
      MEDIA: media,
    },
    observability: OBSERVABILITY,
    rootDir: new URL("../cms", import.meta.url).pathname,
    ...(yield* placementOf("Cms", stage, [])),
  });
});

/**
 * The outbox queue and its dead-letter queue (spec 0008b). A Preview cannot own a queue consumer ("Queue consumers
 * cannot target a Preview", Cloudflare's Previews documentation), and a Preview that produced to the stage's queue
 * would have its ids consumed by the base Worker against the base stage's database. So only production and the base
 * stage have a queue, and a Preview's Worker finds no `OUTBOX_QUEUE` and delivers in `waitUntil`.
 */
const outboxQueues = (stage: string) =>
  Option.match(outboxQueuesFor(stage), {
    onNone: () => Effect.succeedNone,
    onSome: (names) =>
      Effect.gen(function* declareOutboxQueues() {
        return Option.some({
          deadLetter: yield* Cloudflare.Queues.Queue("OutboxDeadLetter", {
            name: names.deadLetter,
          }),
          outbox: yield* Cloudflare.Queues.Queue("Outbox", {
            name: names.queue,
          }),
        });
      }),
  });

type OutboxQueues = Effect.Success<ReturnType<typeof outboxQueues>>;

/**
 * One Worker consumes both queues: its `queue` handler tells them apart by name (`DEAD_LETTER_SUFFIX`). Cloudflare allows
 * one Worker consumer per queue, and a consumer belongs to a script, which is why a Preview cannot have one. The queue's
 * consumer names the dead-letter queue, which is what moves a message there after its last attempt.
 */
const consumeOutbox = (
  queues: OutboxQueues,
  scriptName: Output.Output<string>
) =>
  Effect.gen(function* declareOutboxConsumers() {
    if (Option.isNone(queues)) {
      return;
    }

    yield* Cloudflare.Queues.Consumer("OutboxConsumer", {
      deadLetterQueue: queues.value.deadLetter.queueName,
      queueId: queues.value.outbox.queueId,
      scriptName,
      settings: OUTBOX_CONSUMER,
    });

    yield* Cloudflare.Queues.Consumer("OutboxDeadLetterConsumer", {
      queueId: queues.value.deadLetter.queueId,
      scriptName,
      settings: DEAD_LETTER_CONSUMER,
    });
  });

const web = (cmsWorker: Effect.Success<typeof cms>) =>
  Effect.gen(function* deployWeb() {
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

    // Captured Preview mail needs an absolute link too. Alchemy binds the Worker's own stage URL.
    const siteUrl =
      kind === "production"
        ? yield* Config.NonEmptyString("SITE_URL")
        : Cloudflare.Worker.URL;

    // Alchemy persists one random, Redacted value in each stage's state.
    const authSecret = yield* Alchemy.makeRandom("BetterAuthSecret", {
      bytes: 32,
    });

    const common = {
      BETTER_AUTH_SECRET: authSecret,
      CMS_TOKEN: Config.Redacted("CMS_READ_TOKEN"),
      CMS_URL: reachableAt(cmsWorker),
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
      SITE_URL: siteUrl,
      TURNSTILE_SECRET_KEY: turnstile.secretKey,
      TURNSTILE_SITE_KEY: turnstile.siteKey,
    };

    // Only production binds the real mail and Slack transports; base and previews have no
    // send_email binding at all, and their runtime builds the capture sink.
    const mailFrom =
      deployment === "production"
        ? yield* Config.NonEmptyString("MAIL_FROM")
        : null;

    // The operator's switch for Google Workspace writes (spec 0008): `dry-run` unless production says `write`.
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
            WORKSPACE_MODE: yield* Config.NonEmptyString("WORKSPACE_MODE").pipe(
              Config.withDefault("dry-run")
            ),
          };

    const github = yield* GitHub.GitHubEnv;

    const queues = yield* outboxQueues(stage);

    const worker = yield* Cloudflare.Website.Vite("Web", {
      compatibility: { date: COMPATIBILITY_DATE, flags: COMPATIBILITY_FLAGS },
      env: Option.isNone(queues)
        ? env
        : { ...env, OUTBOX_QUEUE: queues.value.outbox },
      main: WORKER_MAIN,
      observability: OBSERVABILITY,
      ...(yield* placementOf("Web", stage, [...CRON_TRIGGERS])),
    });

    yield* consumeOutbox(queues, worker.workerName);

    // One comment per pull request, updated in place on every push (stable logical id).
    if (github?.pr !== undefined) {
      yield* GitHub.Comment("PreviewComment", {
        body: Output.interpolate`
### Preview

**URL:** ${worker.url}

**CMS (headless; the content API of the site):** ${cmsWorker.url}

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
type DeclaredEnv = Cloudflare.InferEnv<ReturnType<typeof web>>;

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
  Effect.gen(function* stack() {
    const cmsWorker = yield* cms;
    const webWorker = yield* web(cmsWorker);

    return { bindingsMatch, cmsUrl: cmsWorker.url, url: webWorker.url };
  })
);
