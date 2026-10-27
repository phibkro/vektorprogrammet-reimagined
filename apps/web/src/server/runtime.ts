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
 * - After a command commits, the outbox ids it enqueued are delivered in
 *   `ctx.waitUntil`; the cron sweep picks up anything that fails.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { CmsClient } from "@vektorprogrammet/cms-client";
import { layer as cmsLayer } from "@vektorprogrammet/cms-client";
import { DatabaseLive } from "@vektorprogrammet/db";
import type { OutboxDelivery } from "@vektorprogrammet/db";
import {
  CurrentPrincipal,
  Outbox,
  SiteOrigin,
  endingSoonJob,
  semesterJob,
  semesterLabel,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import type {
  AdminGrantRepository,
  AdmissionPeriodRepository,
  AuditLog,
  DepartmentRepository,
  DigestLedger,
  FieldOfStudyRepository,
  FileStore,
  InTransaction,
  MembershipRepository,
  OutboxMessageId,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  PublicFileRepository,
  SemesterRepository,
  SocialEventRepository,
  TeamRepository,
} from "@vektorprogrammet/domain";
import { Cause, Effect, Layer, Predicate, Redacted, Ref } from "effect";
import type { Crypto } from "effect";
import { FetchHttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";

import type { Outcome } from "../lib/outcome";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./env";
import { failureOf, success } from "./errors";
import type { RequestError } from "./errors";
import { r2FileStoreLayer } from "./fileStore";
import { SWEEP_LIMIT } from "./outboxDelivery";
import { withOutbox } from "./outboxSweep";
import { resolvePrincipal } from "./principal";
import { contactRateLimiterLayer } from "./rateLimit";
import type { ContactRateLimiter } from "./rateLimit";
import { messageSenderLayer, senderConfigFromEnv } from "./senders";
import type { MessageSender } from "./senders";
import { Transactor, transactorLayer } from "./transactor";
import { turnstileLiveLayer } from "./turnstile";
import type { TurnstileVerifier } from "./turnstile";
import { webCryptoLayer } from "./webCrypto";

/** Hyperdrive pools connections itself; one request needs very few. */
const MAX_CONNECTIONS_PER_REQUEST = 2;

/** Everything about the request a program may depend on, read before entering Effect. */
export interface RequestScope {
  readonly env: WorkerEnv;
  readonly ctx: Pick<ExecutionContext, "waitUntil">;
  readonly signal: AbortSignal;
  /** Raw `vp-test-actor` cookie (honoured only in a `local` deployment). */
  readonly testActor: string | undefined;
}

/** What `DatabaseLive` provides (packages/db contract). */
export type DatabaseServices =
  | AdmissionPeriodRepository
  | DepartmentRepository
  | SemesterRepository
  | FieldOfStudyRepository
  | SocialEventRepository
  | PublicFileRepository
  | PersonRepository
  | TeamRepository
  | PositionRepository
  | MembershipRepository
  | AdminGrantRepository
  | DigestLedger
  | PrincipalDirectory
  | Outbox
  | AuditLog
  | OutboxDelivery
  | SqlClient.SqlClient;

/** Every service a request program may require. */
export type RequestServices =
  | DatabaseServices
  | Transactor
  | FileStore
  | CurrentPrincipal
  | SiteOrigin
  | Crypto.Crypto
  | TurnstileVerifier
  | ContactRateLimiter
  | CmsClient;

const databaseLayer = (env: WorkerEnv): Layer.Layer<DatabaseServices> =>
  DatabaseLive({
    maxConnections: MAX_CONNECTIONS_PER_REQUEST,
    url: Redacted.make(env.HYPERDRIVE.connectionString),
  }).pipe(Layer.orDie);

/** The live per-request Layer. Infrastructure that fails to build is a defect. */
export const liveRequestLayer = (
  scope: RequestScope
): Layer.Layer<RequestServices> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(scope.env.DEPLOYMENT), (deployment) =>
      Layer.mergeAll(
        transactorLayer,
        r2FileStoreLayer(scope.env.PUBLIC_FILES),
        Layer.effect(
          CurrentPrincipal,
          resolvePrincipal(deployment, scope.testActor)
        ),
        Layer.succeed(SiteOrigin)(scope.env.SITE_URL),
        webCryptoLayer,
        turnstileLiveLayer(Redacted.make(scope.env.TURNSTILE_SECRET_KEY)),
        contactRateLimiterLayer(scope.env.CONTACT_RATE_LIMIT),
        cmsLayer({
          token: Redacted.make(scope.env.CMS_TOKEN),
          url: scope.env.CMS_URL,
        })
      ).pipe(
        Layer.provideMerge(databaseLayer(scope.env)),
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

/** Collects the outbox ids a program enqueues, so they can be delivered after commit. */
const capturingOutbox = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* captureOutboxEffect() {
    const enqueued = yield* Ref.make<readonly OutboxMessageId[]>([]);

    const value = yield* program.pipe(
      Effect.updateService(Outbox, (outbox) =>
        Outbox.of({
          enqueue: (messages) =>
            outbox
              .enqueue(messages)
              .pipe(
                Effect.tap((ids) =>
                  Ref.update(enqueued, (all) => [...all, ...ids])
                )
              ),
        })
      )
    );

    return { enqueued: yield* Ref.get(enqueued), value };
  });

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
  R,
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

/** Outbox delivery with its own connection: used by `waitUntil` and by the cron sweep. */
const deliveryLayer = (
  env: WorkerEnv
): Layer.Layer<MessageSender | DatabaseServices> =>
  Layer.unwrap(
    Effect.map(decodeDeployment(env.DEPLOYMENT), (deployment) =>
      Layer.merge(
        messageSenderLayer(senderConfigFromEnv(deployment, env)).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.orDie
        ),
        databaseLayer(env)
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

export const runDelivery = (
  env: WorkerEnv,
  options?: {
    readonly ids?: readonly OutboxMessageId[];
    readonly limit: number;
  }
): Promise<void> =>
  runScheduled(
    deliveryLayer(env),
    withOutbox((client) =>
      client.sweepOutbox(options ?? { limit: SWEEP_LIMIT })
    ).pipe(
      Effect.provideService(CurrentPrincipal, systemPrincipal("outboxSweep")),
      Effect.tap((results) =>
        Effect.logInfo("outbox delivery finished").pipe(
          Effect.annotateLogs({ rows: results.length })
        )
      )
    )
  );

/** The Layer of the jobs that write: the database, the transaction runner and the site's origin. */
const jobLayer = (
  env: WorkerEnv
): Layer.Layer<DatabaseServices | Transactor | SiteOrigin> =>
  Layer.mergeAll(transactorLayer, Layer.succeed(SiteOrigin)(env.SITE_URL)).pipe(
    Layer.provideMerge(databaseLayer(env))
  );

/**
 * The semester job (spec 0003, RULE-237): the current and the next semester exist as rows. Runs from the
 * cron `scheduled` handler, and nowhere else, as `System("semesters")` through `authorize` (spec 0006, R1); no read
 * path writes a semester.
 */
export const runSemesterJob = (env: WorkerEnv): Promise<void> =>
  runScheduled(
    jobLayer(env),
    Transactor.use((transactor) => transactor.run(semesterJob)).pipe(
      Effect.provideService(CurrentPrincipal, systemPrincipal("semesters")),
      Effect.tap(({ current, next }) =>
        Effect.logInfo("semester job finished").pipe(
          Effect.annotateLogs({
            current: semesterLabel(current),
            next: semesterLabel(next),
          })
        )
      )
    )
  );

/**
 * The "ending soon" digest (spec 0006, falsifier 7): from the cron tick, as `System("endingSoon")`, in one
 * transaction with its ledger rows and outbox rows. Outside the last four weeks of the semester it does nothing.
 */
export const runEndingSoon = (env: WorkerEnv): Promise<void> =>
  runScheduled(
    jobLayer(env),
    Transactor.use((transactor) => transactor.run(endingSoonJob)).pipe(
      Effect.provideService(CurrentPrincipal, systemPrincipal("endingSoon")),
      Effect.tap(({ sent }) =>
        Effect.logInfo("ending-soon digest finished").pipe(
          Effect.annotateLogs({ sent })
        )
      )
    )
  );

/**
 * A prepared command in the live per-request Layer. On success its outbox rows
 * are delivered after the response, in `ctx.waitUntil`.
 */
export const runPreparedCommand = <
  B,
  E0 extends RequestError,
  R0 extends RequestServices,
  A,
  E extends RequestError,
  R extends RequestServices | InTransaction,
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
  ).then((outcome) => {
    if (Predicate.isTagged(outcome, "Failure")) {
      return outcome;
    }

    const { value, enqueued } = outcome.value;

    if (enqueued.length > 0) {
      scope.ctx.waitUntil(
        runDelivery(scope.env, { ids: enqueued, limit: enqueued.length })
      );
    }

    return success(value);
  });

/** A command with nothing to prepare. */
export const runCommand = <
  A,
  E extends RequestError,
  R extends RequestServices | InTransaction,
>(
  scope: RequestScope,
  command: Effect.Effect<A, E, R>
): Promise<Outcome<A>> => runPreparedCommand(scope, Effect.void, () => command);
