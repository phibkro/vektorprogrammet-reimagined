/**
 * Shared steps of the runtime tests: a run directory, a started runtime, the parameters of a renewal, polling, the
 * engine's stored rows, and the privacy check of the engine's files.
 */
import { assert } from "@effect/vitest";
import {
  Array as Arr,
  Config,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { Duration } from "effect";

import type { EventSummary, RenewalInputEncoded } from "../../src/renewal.ts";
import {
  dumpEngine,
  markersInFiles,
  markersInTables,
  rowsOf,
} from "../support/engineStorage.ts";
import type { EngineDatabase } from "../support/engineStorage.ts";
import { api, startRuntime } from "../support/runtime.ts";
import type { Runtime } from "../support/runtime.ts";
import { databaseUrl } from "../support/world.ts";
import type { Fixture } from "../support/world.ts";

/** A directory for one runtime's `.alchemy`: explicit, disposable, kept when `WORKFLOW_SPIKE_KEEP=true`. */
export const runDirectory = Effect.fn("steps.runDirectory")(
  function* runDirectory(label: string) {
    const fs = yield* FileSystem.FileSystem;

    const keep = yield* Config.Boolean("WORKFLOW_SPIKE_KEEP").pipe(
      Config.withDefault(false)
    );

    const directory = yield* fs
      .makeTempDirectory({ prefix: `alchemy-workflows-${label}-` })
      .pipe(Effect.orDie);

    yield* Effect.addFinalizer(() =>
      keep
        ? Effect.logInfo(`kept ${directory}`)
        : fs
            .remove(directory, { force: true, recursive: true })
            .pipe(Effect.orDie)
    );

    return directory;
  }
);

/** Starts `alchemy dev` in `directory` (a fresh run directory when none is given) against the test's database. */
export const start = Effect.fn("steps.start")(function* start(
  label: string,
  directory?: string
) {
  return yield* startRuntime({
    databaseUrl: yield* databaseUrl,
    directory: directory ?? (yield* runDirectory(label)),
    label,
  });
});

/** The parameters of a renewal of `fixture` that is due `after` from now, as the create route takes them. */
export const parametersOf = Effect.fn("steps.parametersOf")(
  function* parametersOf(
    fixture: Fixture,
    renewalId: string,
    after: Duration.Input
  ) {
    const now = yield* DateTime.now;

    return {
      actorId: fixture.personId,
      dueAt: DateTime.formatIso(DateTime.addDuration(now, after)),
      end: fixture.extendedEnd,
      membershipId: fixture.membershipId,
      personId: fixture.personId,
      renewalId,
    } satisfies RenewalInputEncoded;
  }
);

/** Polls the status route until `until` holds, for at most `timeout`; the last status is returned. */
export const awaitStatus = Effect.fn("steps.awaitStatus")(function* awaitStatus(
  runtime: Runtime,
  renewalId: string,
  until: (status: string) => boolean,
  timeout: Duration.Input
) {
  return yield* api(runtime)
    .status(renewalId)
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (report) => until(report.status),
      }),
      Effect.timeout(timeout)
    );
});

/** The event log of an instance, as the events route reports it. */
export const eventsOf = (runtime: Runtime, renewalId: string) =>
  Effect.map(api(runtime).events(renewalId), (report) => report.events);

/** Polls the events route until `until` holds for the log, for at most `timeout`; the events are returned. */
export const awaitEvents = Effect.fn("steps.awaitEvents")(function* awaitEvents(
  runtime: Runtime,
  renewalId: string,
  until: (events: readonly EventSummary[]) => boolean,
  timeout: Duration.Input
) {
  return yield* eventsOf(runtime, renewalId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until,
    }),
    Effect.timeout(timeout)
  );
});

/** Whether the log holds an event of `type`, of the step `step` when one is named. */
export const hasEvent = (
  events: readonly EventSummary[],
  type: string,
  step?: string
): boolean =>
  Arr.some(
    events,
    (event) =>
      event.type === type && (step === undefined || event.stepName === step)
  );

/** The position of the first event of `type` (of the step `step` when one is named) in the log, or -1 when there is none. */
export const eventIndex = (
  events: readonly EventSummary[],
  type: string,
  step?: string
): number =>
  Option.getOrElse(
    Arr.findFirstIndex(
      events,
      (event) =>
        event.type === type && (step === undefined || event.stepName === step)
    ),
    () => -1
  );

/**
 * The events of an instance as one line each, for the evidence log: instant, type, step and attempt. Read the types,
 * the steps, the attempts and the order, not the instants: the engine's `buildWorkflowSubscriptionEvent` parses its
 * SQLite timestamp (UTC text without a zone) with `new Date(...)`, which reads it as host-local time, so under
 * `alchemy dev` an event's instant is early by the host's UTC offset (one hour here). The engine's own tables hold
 * the right instants.
 */
export const describeEvents = (
  events: readonly EventSummary[]
): readonly string[] =>
  Arr.map(events, (event) => {
    const instant = DateTime.formatIso(DateTime.makeUnsafe(event.timestamp));
    const attempt = event.attempt === null ? "-" : `attempt ${event.attempt}`;

    return `${instant} ${event.type} ${event.stepName ?? "-"} ${attempt}`;
  });

/** How many rows the engine's `states` tables hold: its event log, which only the engine appends to. */
export const stateCount = (directory: string) =>
  Effect.map(dumpEngine(directory), (dumps) => rowsOf(dumps, "states").length);

/**
 * The wake-ups that the engine queued and never withdrew: in its `priority_queue` an entry is appended with `action` 1
 * when queued and with `action` 0 when withdrawn, so a queued hash without a withdrawal is still waiting to be woken.
 */
export const pendingWakeups = (dumps: readonly EngineDatabase[]) => {
  const rows = rowsOf(dumps, "priority_queue");

  const withdrawn = Arr.map(
    Arr.filter(rows, (row) => row.action === "0"),
    (row) => row.hash
  );

  return Arr.filter(
    rows,
    (row) => row.action === "1" && !Arr.contains(withdrawn, row.hash)
  );
};

/** The instance parameters as the engine stored them: the `params` of its `workflow_queued` row. */
export const storedParams = Effect.fn("steps.storedParams")(
  function* storedParams(dumps: readonly EngineDatabase[], renewalId: string) {
    const queued = Arr.filter(
      rowsOf(dumps, "states"),
      (row) =>
        row.event === "0" && (row.metadata ?? "").includes(`"${renewalId}"`)
    );

    assert.strictEqual(
      queued.length,
      1,
      "one workflow_queued row for the instance"
    );

    const stored = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ params: Schema.Unknown }))
    )(queued[0]?.metadata).pipe(Effect.orDie);

    return stored.params;
  }
);

/**
 * The privacy check: no name, email address or phone number of the fixture appears in any engine file of the run
 * directory, neither in a table cell (text, or a blob read as Latin-1, UTF-8 and UTF-16) nor in the raw bytes of any
 * file including the WAL. The check is only worth something if it can find: a marker that is planted must be found,
 * which `engineStorage.test.ts` proves against files of the same kind.
 */
export const assertEngineHoldsNoPersonalData = Effect.fn(
  "steps.assertEngineHoldsNoPersonalData"
)(function* assertEngineHoldsNoPersonalData(
  runtime: Pick<Runtime, "directory">,
  fixture: Fixture
) {
  const dumps = yield* dumpEngine(runtime.directory);
  const inTables = markersInTables(dumps, fixture.personalData);

  const inFiles = yield* markersInFiles(
    runtime.directory,
    fixture.personalData
  );

  yield* Effect.logInfo("(d) privacy scan of the engine's files", {
    foundInFiles: inFiles.length,
    foundInTables: inTables.length,
    instanceDatabases: dumps.length,
    markersSearched: fixture.personalData.length,
    stateRows: rowsOf(dumps, "states").length,
  });

  assert.isTrue(dumps.length > 0, "the engine has files to inspect");
  assert.deepStrictEqual(inTables, []);
  assert.deepStrictEqual(inFiles, []);

  return dumps;
});
