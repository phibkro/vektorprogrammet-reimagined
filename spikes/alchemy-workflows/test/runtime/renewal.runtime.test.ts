/**
 * The runtime tests: the membership renewal on the real `alchemy dev` (bun supervisor, sidecar, workerd), with the real
 * local workflow engine and a real PostgreSQL. Heavy: every runtime bundles the Worker and starts workerd, so these run
 * only through `bun run test:runtime`, one file at a time, never in `vp run -r test`.
 *
 * ```
 * (a) retry + dedupe        a task commits ExtendMembership, then fails once; the native retry finds one command
 * (c) stop before the date  a renewal due in 28 days gets a stop event; it ends without renewing
 * (d) privacy               the engine's own files hold no name, email address or phone number
 * (e) custody               closing the scope ends the whole runtime tree
 * (b) restart               SIGKILL the whole runtime during the wait, start a fresh one on the same storage
 * ```
 */
import { assert, layer } from "@effect/vitest";
import { Array as Arr, DateTime, Effect, FileSystem, Predicate } from "effect";

import { RenewalIdSchema, extendCommandId } from "../../src/renewal.ts";
import { awaitGone } from "../support/processes.ts";
import { api } from "../support/runtime.ts";
import { freshTag, ledgerOf, newFixture } from "../support/world.ts";
import type { Ledger } from "../support/world.ts";
import { RestartObservation, restarted } from "./restartObservation.ts";
import { SharedRuntime, sharedRuntime } from "./sharedRuntime.ts";
import {
  assertEngineHoldsNoPersonalData,
  awaitEvents,
  awaitStatus,
  describeEvents,
  eventIndex,
  eventsOf,
  hasEvent,
  parametersOf,
  storedParams,
} from "./steps.ts";

layer(sharedRuntime, { excludeTestServices: true, timeout: "10 minutes" })(
  "alchemy dev + workerd: the renewal workflow",
  (it) => {
    it.effect(
      "(a)+(d) a task that fails after its command committed is retried natively and the command stays one",
      () =>
        Effect.gen(function* retryAndDedupe() {
          const runtime = yield* SharedRuntime;
          const tag = yield* freshTag;
          const fixture = yield* newFixture(tag);
          const renewalId = `retry-${tag}`;
          const commandId = extendCommandId(RenewalIdSchema.make(renewalId));

          const parameters = {
            ...(yield* parametersOf(fixture, renewalId, "8 seconds")),
            fault: "failAfterCommitOnce",
          } as const;

          assert.strictEqual(
            (yield* api(runtime).create(parameters)).status,
            201
          );

          const done = yield* awaitStatus(
            runtime,
            renewalId,
            (status) => status === "complete" || status === "errored",
            "90 seconds"
          );

          assert.strictEqual(done.status, "complete");
          assert.isTrue(Predicate.isTagged(done.outcome, "Renewed"));

          if (Predicate.isTagged(done.outcome, "Renewed")) {
            assert.strictEqual(done.outcome.attempt, 2);
            assert.strictEqual(done.outcome.commandId, commandId);
            assert.strictEqual(done.outcome.version, 2);
          }

          // One command: one receipt, one event, the projection moved once, the notice queued once.
          const ledger: Ledger = yield* ledgerOf(fixture, commandId, renewalId);

          assert.deepStrictEqual(ledger, {
            extensions: 1,
            notices: 1,
            projectedEnd: fixture.extendedEnd,
            receipts: 1,
          });

          yield* Effect.logInfo(
            "(a) the command's ledger in PostgreSQL",
            ledger
          );

          // The native retry: attempt 1 errored after the commit, attempt 2 ran and completed.
          const events = yield* eventsOf(runtime, renewalId);

          assert.deepStrictEqual(
            Arr.map(
              Arr.filter(
                events,
                (event) =>
                  event.type === "attempt_started" &&
                  event.stepName === "extend-membership-1"
              ),
              (event) => event.attempt
            ),
            [1, 2]
          );
          assert.isTrue(
            hasEvent(events, "attempt_errored", "extend-membership-1")
          );
          assert.isTrue(
            hasEvent(events, "attempt_completed", "extend-membership-1")
          );
          assert.isTrue(hasEvent(events, "workflow_completed"));
          yield* Effect.logInfo(
            "(a) the engine's events for the instance",
            describeEvents(events)
          );

          // A stop after the renewal committed is refused, and changes nothing.
          const late = yield* api(runtime).stop(renewalId, fixture.personId);

          assert.strictEqual(late.status, 409);
          assert.deepStrictEqual(late.body, { error: "decided" });
          assert.deepStrictEqual(
            yield* ledgerOf(fixture, commandId, renewalId),
            ledger
          );

          // (d) The engine's stored parameters are the ids and the instant that were sent, and nothing else.
          const dumps = yield* assertEngineHoldsNoPersonalData(
            runtime,
            fixture
          );

          assert.deepStrictEqual(
            yield* storedParams(dumps, renewalId),
            parameters
          );
        })
    );

    it.effect(
      "(c)+(d) a stop before the date, for a renewal due in 28 days, ends it without renewing",
      () =>
        Effect.gen(function* stopBeforeTheDate() {
          const runtime = yield* SharedRuntime;
          const tag = yield* freshTag;
          const fixture = yield* newFixture(tag);
          const renewalId = `stop-${tag}`;
          const commandId = extendCommandId(RenewalIdSchema.make(renewalId));

          // The notice instant is the creation instant: a scheduler would create this instance four weeks before the
          // date. The scheduling is the caller's duty and is not implemented here; the timeline is 28 days exactly.
          assert.strictEqual(
            (yield* api(runtime).create(
              yield* parametersOf(fixture, renewalId, "28 days")
            )).status,
            201
          );

          // The workflow reaches the stop wait.
          yield* awaitEvents(
            runtime,
            renewalId,
            (events) => hasEvent(events, "wait_started", "stop-1"),
            "60 seconds"
          );

          // 28 days is more than a 32-bit millisecond timer can hold. If the engine overflowed, the wait would end at
          // once and the renewal would run: so it is still waiting, and nothing was renewed, five seconds later.
          yield* Effect.sleep("5 seconds");

          const waiting = yield* eventsOf(runtime, renewalId);

          yield* Effect.logInfo(
            "(c) five seconds into the stop wait of a renewal due in 28 days",
            describeEvents(waiting)
          );

          assert.isFalse(hasEvent(waiting, "wait_timed_out"));
          assert.isFalse(
            Arr.some(waiting, (event) =>
              (event.stepName ?? "").startsWith("extend-membership")
            )
          );
          assert.strictEqual(
            (yield* api(runtime).status(renewalId)).status,
            "running"
          );

          const accepted = yield* api(runtime).stop(
            renewalId,
            fixture.personId
          );

          assert.strictEqual(accepted.status, 202);

          const done = yield* awaitStatus(
            runtime,
            renewalId,
            (status) => status === "complete" || status === "errored",
            "30 seconds"
          );

          assert.strictEqual(done.status, "complete");
          assert.isTrue(Predicate.isTagged(done.outcome, "Stopped"));

          if (Predicate.isTagged(done.outcome, "Stopped")) {
            assert.strictEqual(done.outcome.stoppedBy, fixture.personId);
            assert.strictEqual(done.outcome.renewalId, renewalId);
          }

          const events = yield* eventsOf(runtime, renewalId);

          yield* Effect.logInfo(
            "(c) the engine's events for the instance",
            describeEvents(events)
          );
          assert.isTrue(hasEvent(events, "wait_completed", "stop-1"));
          assert.isFalse(
            Arr.some(events, (event) =>
              (event.stepName ?? "").startsWith("extend-membership")
            )
          );

          // No renewal: no receipt, no event, the membership row untouched. The notice was queued once, at the start.
          const ledger = yield* ledgerOf(fixture, commandId, renewalId);

          yield* Effect.logInfo(
            "(c) the command's ledger in PostgreSQL",
            ledger
          );
          assert.deepStrictEqual(ledger, {
            extensions: 0,
            notices: 1,
            projectedEnd: fixture.end,
            receipts: 0,
          });

          // A second stop is refused: the instance has decided.
          assert.strictEqual(
            (yield* api(runtime).stop(renewalId, fixture.personId)).status,
            409
          );

          yield* assertEngineHoldsNoPersonalData(runtime, fixture);
        })
    );

    it.effect(
      "(f) a stop window that closes before the date: the workflow sleeps until the date, a late stop is refused, the renewal commits once",
      () =>
        Effect.gen(function* sleepsToTheDate() {
          const runtime = yield* SharedRuntime;
          const tag = yield* freshTag;
          const fixture = yield* newFixture(tag);
          const renewalId = `sleep-${tag}`;
          const commandId = extendCommandId(RenewalIdSchema.make(renewalId));
          const created = yield* DateTime.now;

          const parameters = {
            ...(yield* parametersOf(fixture, renewalId, "16 seconds")),
            stopUntil: DateTime.formatIso(
              DateTime.addDuration(created, "6 seconds")
            ),
          } as const;

          assert.strictEqual(
            (yield* api(runtime).create(parameters)).status,
            201
          );

          // The window closes six seconds in, and the workflow sleeps until the date, sixteen seconds in.
          yield* awaitEvents(
            runtime,
            renewalId,
            (events) => hasEvent(events, "sleep_started"),
            "30 seconds"
          );

          // A stop now is too late: the stop wait has ended, and the route refuses it.
          assert.strictEqual(
            (yield* api(runtime).stop(renewalId, fixture.personId)).status,
            409
          );

          const done = yield* awaitStatus(
            runtime,
            renewalId,
            (status) => status === "complete" || status === "errored",
            "60 seconds"
          );

          assert.strictEqual(done.status, "complete");
          assert.isTrue(Predicate.isTagged(done.outcome, "Renewed"));

          const events = yield* eventsOf(runtime, renewalId);

          yield* Effect.logInfo(
            "(f) the engine's events for the instance",
            describeEvents(events)
          );
          assert.isTrue(hasEvent(events, "wait_timed_out", "stop-1"));
          assert.isTrue(eventIndex(events, "sleep_completed") > -1);
          assert.isTrue(
            eventIndex(events, "step_started", "extend-membership-1") >
              eventIndex(events, "sleep_completed")
          );

          // The command ran once, after the date.
          const ledger = yield* ledgerOf(fixture, commandId, renewalId);

          yield* Effect.logInfo(
            "(f) the command's ledger in PostgreSQL",
            ledger
          );
          assert.deepStrictEqual(ledger, {
            extensions: 1,
            notices: 1,
            projectedEnd: fixture.extendedEnd,
            receipts: 1,
          });

          yield* assertEngineHoldsNoPersonalData(runtime, fixture);
        })
    );
  }
);

layer(restarted, { excludeTestServices: true, timeout: "10 minutes" })(
  "alchemy dev: SIGKILL during the wait, then a fresh runtime on the same storage",
  (it) => {
    it.effect(
      "(b) OBSERVED (local engine only): the wait is not resumed by itself, by a status read, or after the due time",
      () =>
        Effect.gen(function* observedNoResumption() {
          const seen = yield* RestartObservation;
          const fs = yield* FileSystem.FileSystem;

          // Runtime A's whole tree ended with one SIGKILL (proved inside `crash`: nothing left, port closed).
          assert.isTrue(seen.crashed.length >= 4);

          // The explicit local-only storage path held the engine's files, and runtime B found the same instance there.
          assert.isTrue(
            yield* fs.exists(`${seen.directory}/.alchemy/local/workflows`)
          );
          assert.isTrue(seen.statesBeforeCrash > 0);
          assert.strictEqual(seen.statusAfterRestart, "running");

          // Nothing appended to the engine's log with no request to the instance: not at start, not in the quiet
          // window, not at and after the due time. A resumed wait writes `wait_timed_out` and the extend step.
          assert.strictEqual(seen.statesAfterStart, seen.statesBeforeCrash);
          assert.strictEqual(
            seen.statesAfterQuietWindow,
            seen.statesBeforeCrash
          );
          assert.strictEqual(
            seen.statesAfterStatusRead,
            seen.statesBeforeCrash
          );
          assert.strictEqual(seen.statesAfterDue, seen.statesBeforeCrash);

          // Nor after the first requests since the due time (a status and the event log), once they had time to act.
          assert.strictEqual(seen.statusAfterDue, "running");
          assert.isFalse(hasEvent(seen.eventsAfterDue, "wait_timed_out"));
          assert.isFalse(hasEvent(seen.eventsAfterDue, "workflow_completed"));
          assert.strictEqual(seen.statesSettled, seen.statesBeforeCrash);
          assert.strictEqual(seen.statusSettled, "running");

          // Why: the engine durably recorded the deadline of the stop wait in its wake-up queue (`priority_queue`), and
          // that entry is past due and still queued. Recording it is not waking it: that is the commented-out WAKERS call.
          assert.strictEqual(seen.overdueWakeups.length, 1);

          // And no command: the renewal never reached the database.
          assert.deepStrictEqual(seen.ledger, {
            extensions: 0,
            notices: 1,
            projectedEnd: seen.fixture.end,
            receipts: 0,
          });

          yield* assertEngineHoldsNoPersonalData(
            { directory: seen.directory },
            seen.fixture
          );
        })
    );

    // REQUIRED BY THE ACCEPTANCE, NOT MET. This test states the behavior that is wanted: a fresh runtime resumes the
    // wait by itself, the due time passes, the renewal completes with one command. It fails today because the local
    // engine wakes nothing (`timePriorityQueue.ts`: `add()` and `handleNextAlarm()` leave the WAKERS call commented
    // out), so `it.effect.fails` keeps the gap visible: when Alchemy wires the wake-up, this test starts passing,
    // `fails` turns that into a failure, and someone has to look. Deployed Cloudflare Workflows are not tested here.
    it.effect.fails(
      "(b) REQUIRED, NOT MET LOCALLY: the fresh runtime resumes the wait by itself and the renewal completes with exactly one command",
      () =>
        Effect.gen(function* requiredResumption() {
          const seen = yield* RestartObservation;

          assert.isTrue(
            seen.statesAfterDue > seen.statesBeforeCrash,
            "the engine's log advanced with no request to the instance"
          );
          assert.strictEqual(seen.statusAfterDue, "complete");
          assert.strictEqual(seen.ledger.receipts, 1);
          assert.strictEqual(seen.ledger.extensions, 1);
        })
    );

    it.effect("(e) closing a runtime's scope ends every process it owned", () =>
      Effect.gen(function* scopeCloseEndsTheTree() {
        const seen = yield* RestartObservation;

        assert.isTrue(
          seen.closedPids.length >= 4,
          "supervisor, exec child, sidecar and workerd"
        );

        // Runtime B's scope closed before this test began; none of the pids it owned may be left.
        yield* awaitGone(seen.closedPids);
      })
    );
  }
);
