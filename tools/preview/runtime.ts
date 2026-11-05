import { BunRuntime } from "@effect/platform-bun";
import * as Alchemist from "alchemy/Alchemist";
import type { Services as AlchemistServices } from "alchemy/Alchemist/Runtime";
import { State } from "alchemy/State/State";
import type { StateService } from "alchemy/State/State";
import { Config, Effect, References, Schema } from "effect";
import type { Scope } from "effect";
import { flow } from "effect/Function";

import { STACK_NAME, WORKER_ID, isOwnedWorkerSet } from "./cloudflare.ts";
import { PreviewError } from "./config.ts";

// Alchemy refuses missing or outdated stores with updateStateStore=false only in CI.
export const requirePreviewCI = Effect.fnUntraced(function* requirePreviewCI(
  operation: string
) {
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));

  if (!ci) {
    return yield* new PreviewError({
      message: `Preview ${operation} requires CI=true`,
    });
  }

  return yield* Effect.void;
});

const WorkerProps = Schema.Struct({
  domain: Schema.optional(Schema.Unknown),
  name: Schema.String,
  namespace: Schema.optional(Schema.Unknown),
  preview: Schema.optional(Schema.Unknown),
  routes: Schema.optional(Schema.Array(Schema.Unknown)),
  version: Schema.optional(Schema.Unknown),
});

const WorkerAttributes = Schema.Struct({
  accountId: Schema.String,
  affinityZoneIds: Schema.optional(Schema.Array(Schema.Unknown)),
  domain: Schema.optional(Schema.Unknown),
  namespace: Schema.optional(Schema.Unknown),
  previewOf: Schema.optional(Schema.Unknown),
  routes: Schema.optional(Schema.Array(Schema.Unknown)),
  versionOf: Schema.optional(Schema.Unknown),
  workerName: Schema.String,
});

const WorkerState = Schema.Struct({
  adoptionBlocked: Schema.optional(Schema.Unknown),
  attr: Schema.optional(WorkerAttributes),
  logicalId: Schema.String,
  old: Schema.optional(
    Schema.Struct({ attr: WorkerAttributes, props: WorkerProps })
  ),
  props: WorkerProps,
  propsIncomplete: Schema.optional(Schema.Boolean),
  removalPolicy: Schema.optional(Schema.Literals(["destroy", "retain"])),
  resourceType: Schema.String,
  status: Schema.Literals([
    "creating",
    "created",
    "updating",
    "updated",
    "deleting",
  ]),
});

/** Check every persisted target the Worker provider can mutate. */
export const assertOwnedWorkerState = (
  value: typeof WorkerState.Type,
  workerName: string,
  accountId: string,
  allowMissingAttributes = false
): void => {
  const validProps = (props: typeof WorkerProps.Type) =>
    props.name === workerName &&
    (props.namespace === undefined || props.namespace === null) &&
    (props.version === undefined || props.version === null) &&
    (props.preview === undefined || props.preview === null) &&
    (props.domain === undefined || props.domain === null) &&
    (props.routes?.length ?? 0) === 0;

  const validAttributes = (attr: typeof WorkerAttributes.Type) =>
    attr.accountId === accountId &&
    attr.workerName === workerName &&
    (attr.namespace === undefined || attr.namespace === null) &&
    attr.versionOf === undefined &&
    attr.previewOf === undefined &&
    (attr.domain === undefined || attr.domain === null) &&
    (attr.routes?.length ?? 0) === 0 &&
    (attr.affinityZoneIds?.length ?? 0) === 0;

  if (
    value.resourceType !== "Cloudflare.Worker" ||
    value.logicalId !== WORKER_ID ||
    value.removalPolicy === "retain" ||
    value.propsIncomplete === true ||
    value.adoptionBlocked !== undefined ||
    !validProps(value.props) ||
    (value.attr === undefined
      ? !(allowMissingAttributes && value.status === "creating")
      : !validAttributes(value.attr)) ||
    (value.status === "updating"
      ? value.old === undefined ||
        !validProps(value.old.props) ||
        !validAttributes(value.old.attr)
      : value.old !== undefined)
  ) {
    throw new Error(
      "Refusing preview state: it does not identify exactly the owned Worker"
    );
  }
};

export const listPreviewState = Effect.fnUntraced(function* listPreviewState(
  stage: string
) {
  const store = yield* yield* State;
  const request = { stack: STACK_NAME, stage };
  const rows = yield* store.list(request);
  const replacements = yield* store.getReplacedResources(request);

  return {
    owned: isOwnedWorkerSet(rows, replacements.length !== 0),
    request,
    rows,
    store,
  };
});

export const inspectWorkerRow = (
  workerName: string,
  allowMissingAttributes = false
) =>
  flow(
    Schema.decodeUnknownEffect(WorkerState),
    Effect.flatMap((owned) =>
      Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(
        Effect.flatMap((accountId) =>
          Effect.sync(() => {
            assertOwnedWorkerState(
              owned,
              workerName,
              accountId,
              allowMissingAttributes
            );
          })
        )
      )
    )
  );

export const inspectPreviewState = Effect.fnUntraced(
  function* inspectPreviewState(
    state: {
      store: StateService;
      request: { stack: string; stage: string };
      rows: readonly string[];
    },
    workerName: string,
    allowMissingAttributes: boolean
  ) {
    for (const fqn of state.rows) {
      const row = yield* state.store.get({ ...state.request, fqn });
      yield* inspectWorkerRow(workerName, allowMissingAttributes)(row);
    }
  }
);

type PreviewServices = AlchemistServices | Scope.Scope;

export const runPreview = <A, E>(
  program: Effect.Effect<A, E, PreviewServices>,
  failure?: { message: string; summary: string }
): void => {
  const runnable = program.pipe(
    Effect.scoped,
    Effect.provide(Alchemist.layer())
  );

  if (failure === undefined) {
    BunRuntime.runMain({ disableErrorReporting: true })(runnable);

    return;
  }

  BunRuntime.runMain({ disableErrorReporting: true })(
    runnable.pipe(
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.catchCause(() =>
        Effect.logError(failure.message).pipe(
          Effect.andThen(Effect.die(failure.summary))
        )
      )
    )
  );
};
