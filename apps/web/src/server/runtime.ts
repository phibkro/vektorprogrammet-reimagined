/**
 * The composition root for one Worker request (architecture §3).
 *
 * - The per-request Layer is built here: a Worker cannot reuse I/O objects
 *   across requests, so the database client, R2, and the HTTP client live and
 *   die with the request. Only I/O-free services sit at module scope.
 * - Request data (headers, cookies, form fields) is read by the caller before
 *   the Effect program starts and passed in as plain values (`RequestScope`).
 * - The program runs with the request's `AbortSignal`, so a cancelled request
 *   interrupts it (and rolls back an open transaction).
 * - Typed failures go through the one error table (`failureOf`); defects are
 *   logged and rethrown, which the framework answers with 500.
 * - After a command commits, the outbox ids it enqueued are published in `ctx.waitUntil`: put on the outbox queue where
 *   the Worker has one, delivered right there in a Worker Preview, which has none (spec 0008b). The cron sweep puts back
 *   what a crash or a lost message left without a queue message.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { CmsClient } from "@vektorprogrammet/cms-client";
import { layer as cmsLayer } from "@vektorprogrammet/cms-client";
import { DatabaseLive, JobDatabaseLive } from "@vektorprogrammet/db";
import {
  CurrentPrincipal,
  Job,
  JobRegistry,
  SiteOrigin,
  Transactor,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import type {
  AccountRepository,
  AdminGrantRepository,
  AggregateLocks,
  AdmissionPeriodRepository,
  AlumniRequests,
  AuditLog,
  CapturedMessageStore,
  CodeRepository,
  ConsentRepository,
  DepartmentRepository,
  DigestLedger,
  FieldOfStudyRepository,
  FileStore,
  InTransaction,
  IntegrationPort,
  IsolationProbe,
  NotAnIntegration,
  JobRun,
  LegalHolds,
  MembershipRepository,
  Outbox,
  OutboxDelivery,
  OutboxMessageId,
  OutboxReports,
  PasswordHasher,
  PersonId,
  PersonRepository,
  PersonalDataStore,
  PositionRepository,
  PrincipalDirectory,
  PublicFileRepository,
  SemesterRepository,
  SessionDirectory,
  SignInDirectory,
  SocialEventRepository,
  TeamRepository,
  SystemJob,
  WelcomeLedger,
  WorkspaceAssignments,
  WorkspaceFacts,
  WorkspaceReports,
  WorkspaceWriter,
  RetentionRun,
} from "@vektorprogrammet/domain";
import { Cause, DateTime, Effect, Layer, Predicate, Redacted } from "effect";
import type { Digest, SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";

import type { Outcome } from "../lib/outcome";
import type { AccountDelivery } from "./accountDelivery";
import { accountDeliveryLayer } from "./accountDelivery";
import { Auth, authLayer } from "./auth";
import type { AuthEnvironment } from "./auth";
import { AuthBoundaryFailure } from "./authError";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./env";
import { failureOf, success } from "./errors";
import type { RequestError } from "./errors";
import { r2FileStoreLayer } from "./fileStore";
import { runners } from "./jobRunners";
import type { TickServices } from "./jobRunners";
import { dispatchTick } from "./jobs";
import {
  OutboxPublisher,
  capturingOutbox,
  directPublisherLayer,
  queuePublisherLayer,
} from "./outboxPublisher";
import type { DirectDeliveryServices } from "./outboxPublisher";
import { handleBatch } from "./outboxQueue";
import type { OutboxBatch } from "./outboxQueue";
import { withOutbox } from "./outboxSweep";
import { passwordHasherLayer } from "./password";
import { resolvePrincipal } from "./principal";
import { contactRateLimiterLayer } from "./rateLimit";
import type { ContactRateLimiter } from "./rateLimit";
import { retentionModeFor } from "./retentionMode";
import { messageSenderLayer, senderConfigFromEnv } from "./senders";
import type { MessageSender } from "./senders";
import { turnstileLiveLayer } from "./turnstile";
import type { TurnstileVerifier } from "./turnstile";
import { webCryptoLayer } from "./webCrypto";
import {
  workspaceConfigFromEnv,
  workspaceDirectoryLayer,
  workspaceModeLayer,
  workspaceWriterLayer,
} from "./workspace";

/** Hyperdrive pools connections itself; one request needs very few. */
const MAX_CONNECTIONS_PER_REQUEST = 2;

/** Everything about the request a program may depend on, read before entering Effect. */
export interface RequestScope {
  readonly env: WorkerEnv;
  readonly ctx: Pick<ExecutionContext, "waitUntil">;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  /** Raw `vp-test-actor` cookie (honoured only in a `local` deployment). */
  readonly testActor: string | undefined;
}

/** What `DatabaseLive` provides (packages/db contract). */
export type DatabaseServices =
  | AccountRepository
  | AggregateLocks
  | CodeRepository
  | AdmissionPeriodRepository
  | DepartmentRepository
  | SemesterRepository
  | IsolationProbe
  | FieldOfStudyRepository
  | SocialEventRepository
  | PublicFileRepository
  | PersonRepository
  | TeamRepository
  | PositionRepository
  | MembershipRepository
  | AdminGrantRepository
  | DigestLedger
  | WelcomeLedger
  | ConsentRepository
  | AlumniRequests
  | LegalHolds
  | PersonalDataStore
  | RetentionRun
  | PrincipalDirectory
  | Outbox
  | OutboxReports
  | AuditLog
  | CapturedMessageStore
  | JobRun.JobRuns
  | WorkspaceAssignments
  | WorkspaceFacts
  | WorkspaceReports
  | OutboxDelivery
  | SessionDirectory
  | Transactor
  | SignInDirectory
  | SqlClient.SqlClient;

/** Every service a request program may require. */
export type RequestServices =
  | DatabaseServices
  | Auth
  | PasswordHasher
  | FileStore
  | CurrentPrincipal
  | SiteOrigin
  | Digest.Digest
  | SecureRandom.SecureRandom
  | TurnstileVerifier
  | ContactRateLimiter
  | CmsClient;

/**
 * What a command may require: the request's services without the ports of other systems, and the transaction it runs in.
 * `Transactor.run` refuses a program that requires an integration port (ADR 0015, rule 1; spec 0020), so a command that
 * needs one is a `prepare` step instead, which runs before the transaction opens. `CmsClient` (EmDash's client) is an
 * integration that the domain's marker cannot reach yet (`packages/cms-client` imports no workspace package), so it is
 * left out here by name.
 */
type CommandServices =
  | Exclude<RequestServices, CmsClient | IntegrationPort>
  | InTransaction;

const databaseLayer = (
  env: Pick<TickEnv, "HYPERDRIVE">
): Layer.Layer<DatabaseServices> =>
  DatabaseLive({
    maxConnections: MAX_CONNECTIONS_PER_REQUEST,
    url: Redacted.make(env.HYPERDRIVE.connectionString),
  }).pipe(Layer.orDie);

/**
 * Better Auth over the scope's one database layer (spec 0017, falsifier 7): the library asks the domain through the
 * services that `database` provides, so no second pool is opened for it, and `database` is one build however many
 * layers of the scope need it. Every scope that has Better Auth has it through this function.
 */
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
        r2FileStoreLayer(scope.env.PUBLIC_FILES),
        Layer.effect(
          CurrentPrincipal,
          resolvePrincipal(deployment, scope.testActor, scope.headers)
        ),
        Layer.succeed(SiteOrigin)(scope.env.SITE_URL),
        webCryptoLayer,
        passwordHasherLayer,
        turnstileLiveLayer(Redacted.make(scope.env.TURNSTILE_SECRET_KEY)),
        contactRateLimiterLayer(scope.env.CONTACT_RATE_LIMIT),
        cmsLayer({
          token: Redacted.make(scope.env.CMS_TOKEN),
          url: scope.env.CMS_URL,
        })
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
 * I/O: Turnstile, the rate limit, an R2 upload), then `command(prepared)`
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

/** A query (a read: it must not write) in the live per-request Layer. */
export const runQuery = <A, E extends RequestError, R extends RequestServices>(
  scope: RequestScope,
  program: Effect.Effect<A, E, R>
): Promise<Outcome<A>> =>
  runOutcome(liveRequestLayer(scope), program, scope.signal);

/**
 * Outbox delivery with its own connection: used by `waitUntil` and by the cron tick, which passes the database of the
 * jobs (`jobDatabaseLayer`); a request's delivery has the ordinary one. Better Auth asks the domain through that same
 * database layer (one build, shared by reference). Exported for tests.
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
      accountDeliveryLayer.pipe(
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
 * The publisher of the outbox ids that a commit named (spec 0008b): the queue's, where the Worker has the binding, which
 * needs only the database for the receipt (`queued`); the direct one in a Worker Preview, which has no queue and delivers
 * on the spot, to the capture sink, and needs the whole delivery stack (`direct`). Only the chosen layer is built.
 */
const publisherLayerFor = (
  env: Pick<TickEnv, "OUTBOX_QUEUE">,
  layers: {
    readonly direct: Layer.Layer<DirectDeliveryServices>;
    readonly queued: Layer.Layer<OutboxDelivery>;
  }
): Layer.Layer<OutboxPublisher> =>
  env.OUTBOX_QUEUE === undefined
    ? directPublisherLayer.pipe(Layer.provide(layers.direct))
    : queuePublisherLayer(env.OUTBOX_QUEUE).pipe(Layer.provide(layers.queued));

/**
 * After a command has committed: publish the ids it enqueued, with the request's own database connection pool gone, so
 * on its own connection. Runs in `ctx.waitUntil`, so it never rejects; whatever it could not do is left to the sweep.
 */
export const runPublish = (
  env: TickEnv,
  ids: readonly OutboxMessageId[]
): Promise<void> =>
  runScheduled(
    publisherLayerFor(env, {
      direct: deliveryLayer(env),
      queued: databaseLayer(env),
    }),
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
 * One batch from Cloudflare Queues (spec 0008b): the outbox queue's messages deliver rows, the dead-letter queue's end
 * them (`handleBatch`). The dead-letter queue's branch is built on the database layer only, and a delivery stack that
 * cannot be built is recorded on the rows (`holdForUnavailableStack`). Every message is answered by the handler itself;
 * it rejects only when the database layer cannot be built, and the queue then returns the whole batch.
 */
export const runQueue = (env: TickEnv, batch: OutboxBatch): Promise<void> =>
  Effect.runPromise(
    handleBatch(batch, {
      database: databaseLayer(env),
      delivery: deliveryLayer(env),
    }).pipe(logDefects)
  );

export const runSignInPerson = (
  env: AuthEnvironment,
  input: {
    readonly personId: PersonId;
    readonly password: string;
    readonly headers: Headers;
  },
  signal: AbortSignal,
  database: Layer.Layer<DatabaseServices> = databaseLayer(env)
): Promise<Response> =>
  Effect.runPromise(
    Auth.use((auth) => auth.signInPerson(input)).pipe(
      Effect.provide(authOverDatabase(env, database)),
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
  | "BETTER_AUTH_SECRET"
  | "DEPLOYMENT"
  | "MAIL_FROM"
  | "SEND_EMAIL"
  | "SITE_URL"
  | "SLACK_WEBHOOK_URL"
  | "OUTBOX_QUEUE"
  | "WORKSPACE_MODE"
> & {
  readonly HYPERDRIVE: Pick<WorkerEnv["HYPERDRIVE"], "connectionString">;
};

/**
 * The database of every scheduled job: `JobDatabaseLive`, the only layer that carries a retention run that changes
 * rows, in the mode that `retentionModeFor` decides from the deployment and the approval of the periods (spec 0007b
 * R4). The mode is fixed here, so no job chooses it.
 */
const jobDatabaseLayer = (env: TickEnv): Layer.Layer<DatabaseServices> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(env.DEPLOYMENT), (deployment) =>
      JobDatabaseLive({
        maxConnections: MAX_CONNECTIONS_PER_REQUEST,
        retention: retentionModeFor(deployment),
        url: Redacted.make(env.HYPERDRIVE.connectionString),
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
        publisherLayerFor(env, { direct: delivery, queued: delivery }),
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

/** Each Better Auth path has a separate per-IP bucket on the shared Worker binding. */
export const runAuthRequest = (
  request: Request,
  env: AuthEnvironment & Pick<WorkerEnv, "CONTACT_RATE_LIMIT">,
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
