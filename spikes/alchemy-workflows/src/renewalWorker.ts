/**
 * The Worker of the spike: HTTP routes over the bound workflow handle. It runs in workerd under `alchemy dev`.
 *
 * ```
 * GET  /health                    liveness
 * POST /renewals                  create an instance (the body is `RenewalInput`, encoded)
 * GET  /renewals/:id              the engine's status and, once complete, the outcome
 * GET  /renewals/:id/events       the engine's event log of the instance: types, step names, attempts, instants
 * POST /renewals/:id/stop         deliver a stop event; refused once the instance has decided or the stop wait ended
 * ```
 *
 * The Worker also hosts a second Workflow, the test-only stop sender (`stopWorkflow.ts`), which has no route.
 *
 * Every body is decoded strictly where it arrives, and every response holds identifiers, counts, literals and
 * instants only: a refused request is answered with a fixed word, never with the schema error, which would echo the
 * offending value.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import {
  Array as Arr,
  Data,
  Effect,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { SpikeDeployment } from "./deployment.ts";
import { WORKER_NAME } from "./names.ts";
import {
  EventsReportSchema,
  RenewalIdSchema,
  RenewalInputSchema,
  STOP_EVENT_TYPE,
  StatusReportSchema,
  decodeInput,
  decodeOutcome,
  decodeStop,
} from "./renewal.ts";
import type { EventSummary, RenewalId } from "./renewal.ts";
import RenewalWorkflow from "./renewalWorkflow.ts";
import StopperWorkflow from "./stopWorkflow.ts";

/**
 * The compatibility date of the Worker, and `nodejs_compat` for `pg`. workerd warns that the flag is the default from
 * 2026-08-04; it stays explicit because the bundler decides how to resolve Node built-ins from it (the verified setup).
 */
const COMPATIBILITY = { date: "2026-10-01", flags: ["nodejs_compat"] };

/** The engine's statuses after which an instance has decided. */
const DECIDED: readonly string[] = ["complete", "errored", "terminated"];

/** How long the events route listens: the log replays at once, so a quiet stream means the history is read. */
const HISTORY_IDLE = "400 millis";

const RENEWAL_PATH = /^\/renewals\/(?<id>[^/]+)(?<action>\/events|\/stop)?$/u;

const decodeId = Schema.decodeUnknownOption(RenewalIdSchema);

type Route = Data.TaggedEnum<{
  Create: object;
  Events: { readonly id: RenewalId };
  Health: object;
  Status: { readonly id: RenewalId };
  Stop: { readonly id: RenewalId };
  Unknown: object;
}>;

const Routes = Data.taggedEnum<Route>();

/** The route of a request: a method and a path, with the renewal id decoded where it is read. */
const routeOf = (method: string, pathname: string): Route => {
  if (method === "GET" && pathname === "/health") {
    return Routes.Health();
  }

  if (method === "POST" && pathname === "/renewals") {
    return Routes.Create();
  }

  const match = RENEWAL_PATH.exec(pathname);
  const id = Option.flatMap(Option.fromNullishOr(match?.groups?.id), decodeId);

  if (Option.isNone(id)) {
    return Routes.Unknown();
  }

  const action = match?.groups?.action;

  if (method === "GET" && action === undefined) {
    return Routes.Status({ id: id.value });
  }

  if (method === "GET" && action === "/events") {
    return Routes.Events({ id: id.value });
  }

  if (method === "POST" && action === "/stop") {
    return Routes.Stop({ id: id.value });
  }

  return Routes.Unknown();
};

const refuse = (status: number, error: string) =>
  HttpServerResponse.json({ error }, { status });

/**
 * The Worker's props for the target that the stack's `SpikeDeployment` names (`deployment.ts`; no `Config` read, which
 * Alchemy would bind onto the Worker as a secret). Locally, and in the deployed Worker's runtime where the service is
 * absent and the props are unused, nothing more than the compatibility settings. In the cloud run the Worker has a name
 * of its own, no `workers.dev` URL (nothing can reach its routes: the Workflows API drives the Workflow), and
 * invocation logs, which is where a step's CPU time shows.
 */
const props = Effect.gen(function* workerProps() {
  const deployment = yield* Effect.serviceOption(SpikeDeployment);

  if (Option.exists(deployment, ({ target }) => target === "cloud")) {
    return {
      compatibility: COMPATIBILITY,
      main: import.meta.url,
      name: WORKER_NAME,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
      },
      workersDev: false,
    };
  }

  return { compatibility: COMPATIBILITY, main: import.meta.url };
});

export default class RenewalWorker extends Cloudflare.Worker<RenewalWorker>()(
  "RenewalWorker",
  props,
  Effect.gen(function* renewalWorker() {
    const renewals = yield* RenewalWorkflow;

    // The test-only stop sender (`stopWorkflow.ts`): registered here so that the Worker hosts and binds it; no route starts it.
    yield* StopperWorkflow;

    /** The instance of `id`, or none when the engine has never heard of it. */
    const find = (id: RenewalId) =>
      renewals.get(id).pipe(
        Effect.asSome,
        Effect.catchDefect((defect) =>
          Predicate.isError(defect) &&
          defect.message.includes("instance.not_found")
            ? Effect.succeedNone
            : Effect.die(defect)
        )
      );

    /** The event log of an instance as summaries. The stream replays history and then waits, so it is read until idle. */
    const readEvents = Effect.fn("RenewalWorker.readEvents")(
      function* readEvents(instance: Cloudflare.WorkflowInstance) {
        const seen = yield* Ref.make<readonly EventSummary[]>([]);

        yield* instance.subscribe().pipe(
          Stream.timeout(HISTORY_IDLE),
          Stream.runForEach((event) =>
            Ref.update(seen, (events) => [
              ...events,
              {
                attempt: "attempt" in event ? event.attempt : null,
                eventId: event.eventId,
                stepName: "stepName" in event ? event.stepName : null,
                timestamp: event.timestamp,
                type: event.type,
              },
            ])
          )
        );

        return yield* Ref.get(seen);
      }
    );

    const create = Effect.gen(function* create() {
      const request = yield* HttpServerRequest;
      const input = yield* request.json.pipe(Effect.flatMap(decodeInput));

      const instance = yield* renewals.create({
        id: input.renewalId,
        params: yield* Schema.encodeEffect(RenewalInputSchema)(input).pipe(
          Effect.orDie
        ),
      });

      return yield* HttpServerResponse.json(
        { renewalId: instance.id },
        { status: 201 }
      );
    }).pipe(
      Effect.catchTag(["SchemaError", "HttpServerError"], () =>
        refuse(400, "invalid-request")
      )
    );

    const status = Effect.fn("RenewalWorker.status")(function* status(
      id: RenewalId
    ) {
      const found = yield* find(id);

      if (Option.isNone(found)) {
        return yield* refuse(404, "not-found");
      }

      const reported = yield* found.value.status();

      const outcome = yield* Option.match(
        Option.fromNullishOr(reported.output),
        {
          onNone: () => Effect.succeed(null),
          onSome: (output) => decodeOutcome(output).pipe(Effect.orDie),
        }
      );

      return yield* HttpServerResponse.json(
        yield* Schema.encodeEffect(StatusReportSchema)({
          errorName: reported.error?.name ?? null,
          outcome,
          renewalId: id,
          status: reported.status,
        }).pipe(Effect.orDie)
      );
    });

    const events = Effect.fn("RenewalWorker.events")(function* events(
      id: RenewalId
    ) {
      const found = yield* find(id);

      if (Option.isNone(found)) {
        return yield* refuse(404, "not-found");
      }

      return yield* HttpServerResponse.json(
        yield* Schema.encodeEffect(EventsReportSchema)({
          events: yield* readEvents(found.value),
          renewalId: id,
        }).pipe(Effect.orDie)
      );
    });

    const stop = Effect.fn("RenewalWorker.stop")(
      function* stop(id: RenewalId) {
        const request = yield* HttpServerRequest;
        const payload = yield* request.json.pipe(Effect.flatMap(decodeStop));
        const found = yield* find(id);

        if (Option.isNone(found)) {
          return yield* refuse(404, "not-found");
        }

        const reported = yield* found.value.status();

        if (Arr.contains(DECIDED, reported.status)) {
          return yield* refuse(409, "decided");
        }

        // The stop wait has ended (a stop arrived, or the renewal date came): the command is about to run or has run.
        const ended = Arr.some(
          yield* readEvents(found.value),
          (event) =>
            (event.type === "wait_completed" ||
              event.type === "wait_timed_out") &&
            event.stepName?.startsWith("stop") === true
        );

        if (ended) {
          return yield* refuse(409, "stop-window-closed");
        }

        yield* found.value.sendEvent({ payload, type: STOP_EVENT_TYPE });

        return yield* HttpServerResponse.json(
          { delivered: true, renewalId: id },
          { status: 202 }
        );
      },
      Effect.catchTag(["SchemaError", "HttpServerError"], () =>
        refuse(400, "invalid-request")
      )
    );

    return {
      fetch: Effect.gen(function* fetch() {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.url, "http://worker.local");

        return yield* Routes.$match(routeOf(request.method, pathname), {
          Create: () => create,
          Events: ({ id }) => events(id),
          Health: () => HttpServerResponse.json({ ok: true }),
          Status: ({ id }) => status(id),
          Stop: ({ id }) => stop(id),
          Unknown: () => refuse(404, "not-found"),
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding))
) {}
