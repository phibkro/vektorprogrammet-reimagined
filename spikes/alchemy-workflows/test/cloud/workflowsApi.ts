/**
 * The deployed Workflow, driven through the Workflows API only (the Worker has no public URL): create an instance, stop a
 * renewal through the test-only stopper Workflow (`cf` cannot send an event), read the instance with its steps. Each call
 * is one `cf` invocation (`test/support/cf.ts`).
 *
 * The view of an instance is what `cf workflows instances get` prints, decoded at this edge; every field a test asserts
 * is typed, and the raw text is kept for the evidence file and for the privacy scan.
 */
import {
  Array as Arr,
  Effect,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
} from "effect";
import type { Duration } from "effect";

import { STOPPER_WORKFLOW_NAME } from "../../src/names.ts";
import type {
  RenewalInputEncoded,
  StopRequestEncoded,
} from "../../src/renewal.ts";
import { cf } from "../support/cf.ts";
import type { CfOutput } from "../support/cf.ts";
import { UnreadableApiBody } from "../support/errors.ts";

const Instant = Schema.optional(Schema.NullOr(Schema.String));

const Attempt = Schema.Struct({
  end: Instant,
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  start: Instant,
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const Step = Schema.Struct({
  attempts: Schema.optional(Schema.NullOr(Schema.Array(Attempt))),
  end: Instant,
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.NullOr(Schema.Unknown)),
  start: Instant,
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
});

const InstanceBody = Schema.Struct({
  end: Instant,
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  output: Schema.optional(Schema.NullOr(Schema.Unknown)),
  params: Schema.optional(Schema.NullOr(Schema.Unknown)),
  queued: Instant,
  start: Instant,
  status: Schema.String,
  steps: Schema.optional(Schema.NullOr(Schema.Array(Step))),
});

/** `cf` prints the instance, or the API's envelope around it; both are read. */
const decodeInstance = Schema.decodeUnknownEffect(
  Schema.Union([InstanceBody, Schema.Struct({ result: InstanceBody })])
);

export type Instance = typeof InstanceBody.Type;

export type InstanceStep = typeof Step.Type;

/** An instance as read: the decoded view, and the text it was decoded from. */
export interface InstanceReading {
  readonly instance: Instance;
  readonly raw: string;
}

/** The statuses after which an instance does not move again. */
const TERMINAL = ["complete", "errored", "terminated"] as const;

export const isTerminal = (status: string): boolean =>
  Arr.contains(TERMINAL, status);

const encodeJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown)
);

/**
 * Starts an instance with `params` (ids and instants). The id is unique for the workflow's lifetime. The request body is
 * sent whole, with `--body`: `cf`'s `--params` flag is typed as a string in the CLI's schema and sends its value as a JSON
 * string, so the first deployed instance received a string payload, refused it at the Worker's boundary decode (a bare
 * `SchemaError`, no step ran) and errored. The API's own field names are snake_case.
 */
export const createInstance = Effect.fn("cloud.create")(
  function* createInstance(
    workflowName: string,
    instanceId: string,
    params: RenewalInputEncoded | StopRequestEncoded
  ) {
    const body = yield* encodeJson({ instance_id: instanceId, params }).pipe(
      Effect.orDie
    );

    return yield* cf([
      "workflows",
      "instances",
      "create",
      workflowName,
      "--body",
      body,
    ]);
  }
);

/** Reads an instance with its steps. */
export const readInstance = Effect.fn("cloud.read")(function* readInstance(
  workflowName: string,
  instanceId: string
) {
  const output: CfOutput = yield* cf([
    "workflows",
    "instances",
    "get",
    instanceId,
    "--workflow-name",
    workflowName,
  ]);

  const decoded = yield* decodeInstance(output.json).pipe(
    Effect.mapError(
      (error) =>
        new UnreadableApiBody({
          args: "workflows instances get",
          reason: error.message.slice(0, 300),
        })
    )
  );

  return {
    instance: Predicate.hasProperty(decoded, "result")
      ? decoded.result
      : decoded,
    raw: output.raw,
  } satisfies InstanceReading;
});

/**
 * Polls the instance every `every` until `until` holds for it, for at most `timeout`; the last reading is returned. Each
 * change of its status or of its number of finished steps is logged under `label`: the log is the evidence of what the
 * instance was doing while the test waited.
 */
export const awaitInstance = Effect.fn("cloud.await")(function* awaitInstance(
  label: string,
  workflowName: string,
  instanceId: string,
  until: (instance: Instance) => boolean,
  options: { readonly every: Duration.Input; readonly timeout: Duration.Input }
) {
  const last = yield* Ref.make("");

  return yield* readInstance(workflowName, instanceId).pipe(
    Effect.tap((reading) => {
      const steps = reading.instance.steps ?? [];

      const finished = Arr.filter(
        steps,
        (step) => step.end !== undefined && step.end !== null
      ).length;

      const signature = `${reading.instance.status} steps=${steps.length} finished=${finished}`;

      return Ref.modify(last, (previous) => [
        previous !== signature,
        signature,
      ]).pipe(
        Effect.flatMap((changed) =>
          changed ? Effect.logInfo(`${label} ${signature}`) : Effect.void
        )
      );
    }),
    Effect.repeat({
      schedule: Schedule.spaced(options.every),
      until: (reading) => until(reading.instance),
    }),
    Effect.timeout(options.timeout)
  );
});

/** The steps of an instance, in the order the API reports them. */
export const stepsOf = (instance: Instance): readonly InstanceStep[] =>
  instance.steps ?? [];

/**
 * The first step whose name starts with `prefix`: `queue-notice`, `stop` (the `waitForEvent`), `renewal-date` (the
 * `sleepUntil`) or `extend-membership`. The lookup is by name, never by the API's `type` string, so that an absence check
 * cannot pass because the API spells a type differently.
 */
export const stepNamed = (
  instance: Instance,
  prefix: string
): InstanceStep | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(stepsOf(instance), (step) =>
      (step.name ?? "").startsWith(prefix)
    )
  );

/** The steps as one line each for the evidence log: type, name, start, end, success and the number of attempts. */
export const describeSteps = (instance: Instance): readonly string[] =>
  Arr.map(
    stepsOf(instance),
    (step) =>
      `${step.type ?? "?"} ${step.name ?? "?"} ${step.start ?? "-"} -> ${step.end ?? "-"} success=${String(step.success ?? "-")} attempts=${String(step.attempts?.length ?? 0)}`
  );

/**
 * Stops a renewal through the Worker: starts an instance of the test-only stopper Workflow, whose body sends the
 * `renewal-stop` event through the Workflows binding (`cf` cannot send an event: no body in its schema, and the API
 * refuses a body-less send), and waits until the stopper has decided. `stoppedBy` is the event's payload; none sends an
 * anonymous stop. `label` keeps the stopper's instance id unique, since an id is unique for the workflow's lifetime.
 */
export const stopThroughWorker = Effect.fn("cloud.stopThroughWorker")(
  function* stopThroughWorker(
    label: string,
    renewalId: string,
    stoppedBy?: number
  ) {
    const stopperId = `stopper-${label}-${renewalId}`;

    const created = yield* createInstance(
      STOPPER_WORKFLOW_NAME,
      stopperId,
      stoppedBy === undefined ? { renewalId } : { renewalId, stoppedBy }
    );

    const done = yield* awaitInstance(
      `stopper ${label}`,
      STOPPER_WORKFLOW_NAME,
      stopperId,
      (instance) => isTerminal(instance.status),
      { every: "2 seconds", timeout: "2 minutes" }
    );

    return { created, done, stopperId };
  }
);
