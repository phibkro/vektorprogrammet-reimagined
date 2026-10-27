/**
 * The restart scenario, run once and observed: runtime A starts a renewal that is due in 75 seconds and reaches the stop
 * wait; the whole runtime is SIGKILLed; runtime B starts on the same directory (so the same local storage) and the same
 * database. B is then watched, and what it does or does not do to the engine's log is the observation.
 *
 * Nothing here helps the engine along. There is no `sendEvent`, no `restart`, no `resume`: the claim under test is
 * that a restarted runtime resumes the wait by itself, so a nudge would test something else.
 */
import { assert } from "@effect/vitest";
import {
  Array as Arr,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
} from "effect";

import { RenewalIdSchema, extendCommandId } from "../../src/renewal.ts";
import type { EventSummary } from "../../src/renewal.ts";
import { dumpEngine } from "../support/engineStorage.ts";
import { descendantsOf } from "../support/processes.ts";
import { api, crash } from "../support/runtime.ts";
import { freshTag, ledgerOf, newFixture } from "../support/world.ts";
import type { Fixture, Ledger } from "../support/world.ts";
import { base } from "./base.ts";
import {
  awaitEvents,
  describeEvents,
  eventsOf,
  hasEvent,
  parametersOf,
  pendingWakeups,
  runDirectory,
  start,
  stateCount,
} from "./steps.ts";

/** What the restart scenario observed, read once and asserted by the two (b) tests. */
export interface Observation {
  /** The host pids that runtime A owned, all gone after one SIGKILL of its `unshare` process. */
  readonly crashed: readonly number[];
  /** The host pids that runtime B owned when its scope closed: closing the scope has to end all of them. */
  readonly closedPids: readonly number[];
  /** The directory both runtimes ran in: the explicit local-only storage path is `<directory>/.alchemy/local`. */
  readonly directory: string;
  readonly eventsAfterDue: readonly EventSummary[];
  readonly fixture: Fixture;
  readonly ledger: Ledger;
  /** Instants of the wake-ups that the engine queued, never withdrew, and that were already due when B was last read. */
  readonly overdueWakeups: readonly string[];
  readonly renewalId: string;
  readonly statesAfterDue: number;
  readonly statesAfterQuietWindow: number;
  readonly statesAfterStart: number;
  readonly statesAfterStatusRead: number;
  readonly statesBeforeCrash: number;
  readonly statesSettled: number;
  readonly statusAfterDue: string;
  readonly statusAfterRestart: string;
  readonly statusSettled: string;
}

export class RestartObservation extends Context.Service<
  RestartObservation,
  Observation
>()("test/RestartObservation") {}

/** How long runtime B is watched with no request to the instance, and how long after the due time. */
const QUIET_WINDOW = "15 seconds";
const AFTER_DUE = Duration.seconds(10);

const restartScenario = Effect.gen(function* restartScenario() {
  const tag = yield* freshTag;
  const fixture = yield* newFixture(tag);
  const renewalId = `restart-${tag}`;
  const commandId = extendCommandId(RenewalIdSchema.make(renewalId));
  const directory = yield* runDirectory("restart");
  const parameters = yield* parametersOf(fixture, renewalId, "75 seconds");

  // Runtime A: the instance reaches the stop wait, then the whole runtime is SIGKILLed.
  const { crashed, statesBeforeCrash } = yield* Effect.scoped(
    Effect.gen(function* runtimeA() {
      const a = yield* start("A", directory);

      assert.strictEqual((yield* api(a).create(parameters)).status, 201);
      yield* awaitEvents(
        a,
        renewalId,
        (events) => hasEvent(events, "wait_started", "stop-1"),
        "30 seconds"
      );

      const before = yield* stateCount(directory);

      return { crashed: yield* crash(a), statesBeforeCrash: before };
    })
  );

  // Runtime B: a fresh process tree on the same directory, so the same local storage, and the same database.
  const { owned: closedPids, ...observed } = yield* Effect.scoped(
    Effect.gen(function* runtimeB() {
      const b = yield* start("B", directory);

      const statesAfterStart = yield* stateCount(directory);

      // No request to the instance at all for the quiet window: only the engine's own files are read.
      yield* Effect.sleep(QUIET_WINDOW);

      const statesAfterQuietWindow = yield* stateCount(directory);

      // The first request the instance gets: the status route (a get and a status through the Workflow handle).
      const statusAfterRestart = (yield* api(b).status(renewalId)).status;

      yield* Effect.sleep("3 seconds");

      const statesAfterStatusRead = yield* stateCount(directory);

      // Wait until the due time has passed by AFTER_DUE, with no further request to the instance.
      const now = yield* DateTime.now;
      const due = DateTime.makeUnsafe(parameters.dueAt);

      yield* Effect.sleep(
        Duration.sum(
          Duration.max(Duration.zero, DateTime.distance(now, due)),
          AFTER_DUE
        )
      );

      const statesAfterDue = yield* stateCount(directory);

      // The first requests to the instance since the due time passed: a status and the event log. If a request
      // revives the engine, the lapsed wait times out and the log advances, so the log is read again after a pause.
      const statusAfterDue = (yield* api(b).status(renewalId)).status;
      const eventsAfterDue = yield* eventsOf(b, renewalId);

      yield* Effect.sleep("5 seconds");

      const statesSettled = yield* stateCount(directory);
      const statusSettled = (yield* api(b).status(renewalId)).status;
      const ledger = yield* ledgerOf(fixture, commandId, renewalId);

      // The engine's persisted wake-ups that were already due when B was last observed and are still queued.
      const settledAt = yield* DateTime.now;

      const overdueWakeups = Arr.map(
        Arr.filter(
          pendingWakeups(yield* dumpEngine(directory)),
          (row) =>
            Number(row.target_timestamp) < DateTime.toEpochMillis(settledAt)
        ),
        (row) =>
          DateTime.formatIso(DateTime.makeUnsafe(Number(row.target_timestamp)))
      );

      // What B owns just before its scope closes: the closing has to end all of it.
      const owned = Arr.dedupe([...b.owned, ...(yield* descendantsOf(b.pid))]);

      return {
        crashed,
        directory,
        eventsAfterDue,
        fixture,
        ledger,
        overdueWakeups,
        owned,
        renewalId,
        statesAfterDue,
        statesAfterQuietWindow,
        statesAfterStart,
        statesAfterStatusRead,
        statesBeforeCrash,
        statesSettled,
        statusAfterDue,
        statusAfterRestart,
        statusSettled,
      };
    })
  );

  yield* Effect.logInfo(
    "(b) restart observation (host pids, engine log row counts, statuses, events, ledger)",
    {
      closedPids: closedPids.length,
      crashedPids: observed.crashed.length,
      dueAt: parameters.dueAt,
      eventsAfterDue: describeEvents(observed.eventsAfterDue),
      ledger: observed.ledger,
      overdueWakeups: observed.overdueWakeups,
      stateRowsAfterDue: observed.statesAfterDue,
      stateRowsAfterQuietWindow: observed.statesAfterQuietWindow,
      stateRowsAfterStart: observed.statesAfterStart,
      stateRowsAfterStatusRead: observed.statesAfterStatusRead,
      stateRowsBeforeCrash: observed.statesBeforeCrash,
      stateRowsSettled: observed.statesSettled,
      statusAfterDue: observed.statusAfterDue,
      statusAfterRestart: observed.statusAfterRestart,
      statusSettled: observed.statusSettled,
    }
  );

  return { ...observed, closedPids } satisfies Observation;
});

export const restarted = Layer.effect(RestartObservation, restartScenario).pipe(
  Layer.provideMerge(base)
);
