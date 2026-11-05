/** One request owns the database and SDK adapters; domain transactions commit before delivery. */
import type { ExecutionContext } from "@cloudflare/workers-types";
import { Cause, DateTime, Effect, Layer, Predicate, Redacted } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import { contactRateLimiterLayer } from "../adapters/cloudflare/rateLimit";
import type { ContactRateLimiter } from "../adapters/cloudflare/rateLimit";
import { ContentLive } from "../adapters/db/content";
import { DatabaseLive, JobDatabaseLive } from "../adapters/db/databaseLive";
import { runtimeDatabaseUrl } from "../adapters/db/runtimeUrl";
import {
  messageSenderLayer,
  senderConfigFromEnv,
} from "../adapters/messaging/senders";
import type { MessageSender } from "../adapters/messaging/senders";
import { supabaseFileStoreLayer } from "../adapters/supabase/storage";
import { turnstileLiveLayer } from "../adapters/turnstile";
import type { TurnstileVerifier } from "../adapters/turnstile";
import { webCryptoLayer } from "../adapters/webCrypto";
import {
  workspaceConfigFromEnv,
  workspaceDirectoryLayer,
  workspaceModeLayer,
  workspaceWriterLayer,
} from "../adapters/workspace";
import type { OutboxMessageId } from "../core/ids";
import * as Job from "../core/jobs/job";
import * as JobRegistry from "../core/jobs/registry";
import { CurrentPrincipal, systemPrincipal } from "../core/kernel/principal";
import type { SystemJob } from "../core/kernel/principal";
import type { Outbox } from "../core/outbox/outbox";
import { SiteOrigin } from "../core/siteOrigin";
import type {
  InTransaction,
  IntegrationPort,
  NotAnIntegration,
} from "../core/transactions/transaction";
import { Transactor } from "../core/transactions/transactor";
import type { CmsClient, ContentEditor } from "../features/cms/domain/client";
import type { FileStore } from "../features/files/domain/services";
import type { WorkspaceWriter } from "../features/workspace/domain/services";
import type { Outcome } from "../http/outcome";
import { success } from "../http/outcome";
import type { RequestError } from "../http/requestError";
import type { AccountDelivery } from "./background/outbox/accountDelivery";
import { accountDeliveryLayer } from "./background/outbox/accountDelivery";
import {
  OutboxPublisher,
  capturingOutbox,
  directPublisherLayer,
} from "./background/outbox/publisher";
import type { DirectDeliveryServices } from "./background/outbox/publisher";
import { withOutbox } from "./background/outbox/sweep";
import { retentionModeFor } from "./background/retentionMode";
import { runners } from "./background/runners";
import type { TickServices } from "./background/runners";
import { dispatchTick } from "./background/scheduler";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./http/env";
import { failureOf } from "./http/errors";
import { legacyFileLocation } from "./http/redirects";
import { Auth, authLayer } from "./identity/auth";
import type { AuthEnvironment } from "./identity/auth";
import { AuthBoundaryFailure } from "./identity/authError";
import { resolvePrincipal } from "./identity/principal";
import type { DatabaseServices } from "./services";

/** Keep the short-lived request pool small; Supabase supplies the shared database. */
const MAX_CONNECTIONS_PER_REQUEST = 2;

/** Everything about the request a program may depend on, read before entering Effect. */
export interface RequestScope {
  readonly env: WorkerEnv;
  readonly ctx: Pick<ExecutionContext, "waitUntil">;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

/** Every service a request program may require. */
export type RequestServices =
  | DatabaseServices
  | Auth
  | FileStore
  | CurrentPrincipal
  | SiteOrigin
  | Digest.Digest
  | SecureRandom.SecureRandom
  | TurnstileVerifier
  | ContactRateLimiter
  | CmsClient
  | ContentEditor;

/**
 * What a command may require: the request's services without the ports of other systems, and the transaction it runs in.
 * `Transactor.run` refuses a program that requires an integration port (ADR 0015, rule 1; spec 0020), so a command that
 * needs one is a `prepare` step instead, which runs before the transaction opens.
 * The separate published-content read port is also excluded from domain commands.
 */
type CommandServices =
  | Exclude<RequestServices, CmsClient | IntegrationPort>
  | InTransaction;

const databaseLayer = (
  env: Pick<TickEnv, "DATABASE_URL">
): Layer.Layer<DatabaseServices> =>
  DatabaseLive({
    maxConnections: MAX_CONNECTIONS_PER_REQUEST,
    url: runtimeDatabaseUrl(env.DATABASE_URL),
  }).pipe(Layer.orDie);

/** Authentication asks the domain through the same request-scoped database layer. */
const authOverDatabase = (
  env: AuthEnvironment,
  database: Layer.Layer<DatabaseServices>
) => authLayer(env).pipe(Layer.orDie, Layer.provideMerge(database));

/**
 * The live per-request Layer. Infrastructure that fails to build is a defect. `database` is the request's one database
 * layer (a test passes its own, to count its builds).
 */
export const liveRequestLayer = (
  scope: RequestScope,
  database: Layer.Layer<DatabaseServices> = databaseLayer(scope.env)
): Layer.Layer<RequestServices> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(scope.env.DEPLOYMENT), (deployment) =>
      Layer.mergeAll(
        workspaceModeLayer(workspaceConfigFromEnv(deployment, scope.env)),
        supabaseFileStoreLayer(scope.env),
        Layer.effect(CurrentPrincipal, resolvePrincipal(scope.headers)),
        Layer.succeed(SiteOrigin)(scope.env.SITE_URL),
        webCryptoLayer,
        turnstileLiveLayer(Redacted.make(scope.env.TURNSTILE_SECRET_KEY)),
        contactRateLimiterLayer(scope.env.CONTACT_RATE_LIMIT),
        ContentLive.pipe(Layer.provide(database))
      ).pipe(
        Layer.provideMerge(authOverDatabase(scope.env, database)),
        Layer.provide(FetchHttpClient.layer)
      )
    )
  );

const logDefects = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("request failed with a defect", Cause.pretty(cause))
    )
  );

/**
 * Runs `program` against `layer` and maps typed failures through the error
 * table. Exported for tests, which pass in-memory Layers.
 */
export const runOutcome = <A, E extends RequestError, R>(
  layer: Layer.Layer<R>,
  program: Effect.Effect<A, E, R>,
  signal: AbortSignal
): Promise<Outcome<A>> =>
  Effect.runPromise(
    program.pipe(
      Effect.map(success),
      Effect.catch((error: E) => Effect.succeed(failureOf(error))),
      Effect.provide(layer),
      logDefects
    ),
    { signal }
  );

/** The successful result of a command plus the outbox ids committed with it. */
export interface Committed<A> {
  readonly value: A;
  readonly enqueued: readonly OutboxMessageId[];
}

/**
 * A command in two steps: `prepare` runs OUTSIDE any transaction (provider
 * I/O: Turnstile, the rate limit, a Storage upload), then `command(prepared)`
 * runs inside one through `Transactor`. Exported for tests.
 */
export const runCommandOutcome = <
  B,
  E0 extends RequestError,
  R0,
  A,
  E extends RequestError,
  R extends NotAnIntegration,
>(
  layer: Layer.Layer<
    NoInfer<R0 | Exclude<R, InTransaction>> | Transactor | Outbox
  >,
  prepare: Effect.Effect<B, E0, R0>,
  command: (prepared: B) => Effect.Effect<A, E, R>,
  signal: AbortSignal
): Promise<Outcome<Committed<A>>> =>
  runOutcome(
    layer,
    Effect.flatMap(prepare, (prepared) =>
      capturingOutbox(
        Effect.gen(function* runTransactedCommand() {
          const transactor = yield* Transactor;

          return yield* transactor.run(command(prepared));
        })
      )
    ),
    signal
  );

/** A public registry lookup also runs before Start has installed an SSR cookie context. */
export const runLegacyFileRedirect = (
  scope: Pick<RequestScope, "env" | "signal">,
  legacyPath: string
) =>
  runOutcome(
    databaseLayer(scope.env),
    legacyFileLocation(legacyPath),
    scope.signal
  );

/** A query (a read: it must not write) in the live per-request Layer. */
export const runQuery = <A, E extends RequestError, R extends RequestServices>(
  scope: RequestScope,
  program: Effect.Effect<A, E, R>
): Promise<Outcome<A>> =>
  runOutcome(liveRequestLayer(scope), program, scope.signal);

/**
 * Post-commit delivery owns its database connection. Scheduled delivery receives
 * the job database; request delivery uses the ordinary database. Exported for tests.
 */
export const deliveryLayer = (
  env: TickEnv,
  database: Layer.Layer<DatabaseServices> = databaseLayer(env)
): Layer.Layer<
  | AccountDelivery
  | MessageSender
  | WorkspaceWriter
  | DatabaseServices
  | Auth
  | Digest.Digest
  | SecureRandom.SecureRandom
  | SiteOrigin
> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(env.DEPLOYMENT), (deployment) =>
      accountDeliveryLayer(env).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            messageSenderLayer(senderConfigFromEnv(deployment, env)).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.orDie,
              Layer.provideMerge(database)
            ),
            workspaceWriterLayer(workspaceConfigFromEnv(deployment, env)),
            authOverDatabase(env, database),
            webCryptoLayer,
            Layer.succeed(SiteOrigin)(env.SITE_URL)
          )
        )
      )
    )
  );

/**
 * A scheduled job: its own Layer, defects logged, and a failed run left for the next cron tick, so
 * it never rejects `waitUntil`.
 */
const runScheduled = <A, E, R>(
  layer: Layer.Layer<R>,
  job: Effect.Effect<A, E, R>
): Promise<void> =>
  Effect.runPromise(
    job.pipe(
      Effect.asVoid,
      Effect.provide(layer),
      logDefects,
      Effect.ignoreCause
    )
  );

/**
 * Post-commit publication delivers directly; durable outbox rows back scheduled retries.
 */
const publisherLayerFor = (
  delivery: Layer.Layer<DirectDeliveryServices>
): Layer.Layer<OutboxPublisher> =>
  directPublisherLayer.pipe(Layer.provide(delivery));

/**
 * After a command has committed: publish the ids it enqueued, with the request's own database connection pool gone, so
 * on its own connection. Runs in `ctx.waitUntil`, so it never rejects; whatever it could not do is left to the sweep.
 */
export const runPublish = (
  env: TickEnv,
  ids: readonly OutboxMessageId[]
): Promise<void> =>
  runScheduled(
    publisherLayerFor(deliveryLayer(env)),
    OutboxPublisher.use((publisher) => publisher.publish(ids))
  );

/**
 * Activation and reset wait for their own credential intent after the domain commit: the rows are delivered here and
 * now, by the same claim as the queue's consumer, and the caller reads what became of each.
 */
export const runDeliveryChecked = (
  env: WorkerEnv,
  ids: readonly OutboxMessageId[],
  signal: AbortSignal
) =>
  Effect.runPromise(
    withOutbox((client) => client.deliverOutbox({ ids })).pipe(
      Effect.provideService(CurrentPrincipal, systemPrincipal("outboxSweep")),
      Effect.provide(deliveryLayer(env)),
      Effect.orDie,
      logDefects
    ),
    { signal }
  );

/**
 * What a scheduled tick reads of the Worker's bindings: the deployment, the site's origin, the database's connection
 * string, the Better Auth secret, the senders' production bindings and the Workspace mode. A test runs the tick without a
 * Cloudflare binding (`WorkerEnv` satisfies it).
 */
export type TickEnv = Pick<
  WorkerEnv,
  | "DATABASE_URL"
  | "SUPABASE_URL"
  | "SUPABASE_PUBLISHABLE_KEY"
  | "SUPABASE_SECRET_KEY"
  | "DEPLOYMENT"
  | "MAIL_FROM"
  | "SEND_EMAIL"
  | "SITE_URL"
  | "SLACK_WEBHOOK_URL"
  | "WORKSPACE_MODE"
>;

/**
 * The database of every scheduled job: `JobDatabaseLive`, the only layer that carries a retention run that changes
 * rows, in the mode that `retentionModeFor` decides from the deployment and the approval of the periods (spec 0007b
 * R4). The mode is fixed here, so no job chooses it.
 */
const jobDatabaseLayer = (env: TickEnv): Layer.Layer<DatabaseServices> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(env.DEPLOYMENT), (deployment) =>
      JobDatabaseLive({
        retention: retentionModeFor(deployment),
        url: runtimeDatabaseUrl(env.DATABASE_URL),
      }).pipe(Layer.orDie)
    )
  );

/**
 * The Layer of one scheduled tick (spec 0008): the delivery services, which hold the job database, the senders and the
 * Workspace writer, the transaction runner, and the Workspace directory and mode by deployment.
 */
const tickLayer = (env: TickEnv): Layer.Layer<TickServices | Transactor> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(env.DEPLOYMENT), (deployment) => {
      const workspace = workspaceConfigFromEnv(deployment, env);
      const delivery = deliveryLayer(env, jobDatabaseLayer(env));

      return Layer.mergeAll(
        workspaceDirectoryLayer(workspace),
        workspaceModeLayer(workspace),
        publisherLayerFor(delivery),
        delivery
      );
    })
  );

/**
 * One cron tick: every registered job of that cron that is due runs (spec 0008), each as its own `System` principal,
 * in declaration order, and one that fails never stops the next. The platform always names the cron that fired; only a
 * local trigger (`/cdn-cgi/handler/scheduled`) passes none, and it runs the ten-minute tick, so the nightly retention
 * run needs its own cron string (spec 0007b). Never rejects, so `waitUntil` is safe; a run that failed or died is
 * recorded in `job_run` and left for a later tick.
 */
export const runTick = (
  env: TickEnv,
  controller: { readonly scheduledTime: number; readonly cron: string },
  only?: readonly SystemJob[]
): Promise<void> =>
  runScheduled(
    tickLayer(env),
    dispatchTick(JobRegistry.Jobs, runners, {
      at: DateTime.makeUnsafe(controller.scheduledTime),
      cron: controller.cron === "" ? Job.TICK_CRON : controller.cron,
      only,
    })
  );

/**
 * What follows a command's outcome: nothing for a failure, and for a success the publication of the ids it committed,
 * after the response. Exported for the test that runs a real command first (spec 0008b falsifier 1).
 */
export const publishCommitted = <A>(
  scope: Pick<RequestScope, "ctx"> & { readonly env: TickEnv },
  outcome: Outcome<Committed<A>>
): Outcome<A> => {
  if (Predicate.isTagged(outcome, "Failure")) {
    return outcome;
  }

  const { value, enqueued } = outcome.value;

  if (enqueued.length > 0) {
    scope.ctx.waitUntil(runPublish(scope.env, enqueued));
  }

  return success(value);
};

/**
 * A prepared command in the live per-request Layer. On success its outbox rows are published after the response, in
 * `ctx.waitUntil` (`runPublish`); a rollback or a refusal published nothing.
 */
export const runPreparedCommand = <
  B,
  E0 extends RequestError,
  R0 extends RequestServices,
  A,
  E extends RequestError,
  R extends CommandServices,
>(
  scope: RequestScope,
  prepare: Effect.Effect<B, E0, R0>,
  command: (prepared: B) => Effect.Effect<A, E, R>
): Promise<Outcome<A>> =>
  runCommandOutcome(
    liveRequestLayer(scope),
    prepare,
    command,
    scope.signal
  ).then((outcome) => publishCommitted(scope, outcome));

/** A command with nothing to prepare. */
export const runCommand = <
  A,
  E extends RequestError,
  R extends CommandServices,
>(
  scope: RequestScope,
  command: Effect.Effect<A, E, R>
): Promise<Outcome<A>> => runPreparedCommand(scope, Effect.void, () => command);

/** Auth endpoints share a per-IP limiter; every handler validates the provider session. */
export const runAuthRequest = (
  request: Request,
  env: AuthEnvironment & Pick<WorkerEnv, "CONTACT_RATE_LIMIT" | "DATABASE_URL">,
  database: Layer.Layer<DatabaseServices> = databaseLayer(env)
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* authRequest() {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

      const result = yield* Effect.tryPromise({
        catch: (cause) => new AuthBoundaryFailure({ cause }),
        try: () =>
          env.CONTACT_RATE_LIMIT.limit({
            key: `auth:${new URL(request.url).pathname}:${ip}`,
          }),
      });

      if (!result.success) {
        return new Response("Too Many Requests", { status: 429 });
      }

      return yield* (yield* Auth).handle(request);
    }).pipe(Effect.provide(authOverDatabase(env, database)), Effect.orDie),
    { signal: request.signal }
  );
