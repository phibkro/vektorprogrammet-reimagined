/**
 * The deployed run of the renewal Workflow, one short run on Cloudflare: the Worker `vp-spike-workflows` (no public URL)
 * and its Workflows, driven only through the Workflows API (`cf`), with the renewals' rows in a throwaway Neon branch
 * that the Worker reaches through Hyperdrive as `vp_app`. Start it with `scripts/with-neon-branch.sh owner <branch> …`
 * under `secretspec run --`; it needs `DATABASE_URL` (the branch, as its owner: fixtures, grants and the ledger queries)
 * and `CLOUD_EVIDENCE_DIR` (where the API's JSON of each instance is kept, outside the repository).
 *
 * `cf` cannot send a Workflows event (its schema declares no request body, and the API answers a body-less send with
 * `400 [10002] workflows.api.error.body`), so a stop is sent from the Worker through the Workflows binding by the
 * test-only stopper Workflow (`src/stopWorkflow.ts`), which `cf` starts like any instance.
 *
 * Five scenarios, each over its own synthetic person in the high id range:
 *
 * - (a) a task that commits and then fails once is retried natively, and the command stays one;
 * - (c) a stop that names who stopped it, sent before the date, ends the instance with no renewal;
 * - (g) an anonymous stop (an empty event payload) does the same and names nobody;
 * - (e) with no stop event the `waitForEvent` times out at the date and the instance wakes: a durable wait of two and a
 *   half minutes, then a step;
 * - (f) a stop window that closes early (`stopUntil`, the spike's test seam) leaves a real `sleepUntil` to the date,
 *   and a stop sent inside the sleep is not heard.
 *
 * Each ends with the privacy check: what the Workflows API holds of the instance and of its stopper (parameters, output,
 * steps, and the decoded Cause inside a failed attempt's error) names ids and instants only.
 */
import { assert, layer } from "@effect/vitest";
import {
  Array as Arr,
  Config,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { WORKFLOW_NAME } from "../../src/names.ts";
import {
  RenewalIdSchema,
  decodeOutcome,
  extendCommandId,
} from "../../src/renewal.ts";
import { parametersOf } from "../runtime/steps.ts";
import { nodeServicesLayer } from "../support/nodeServices.ts";
import { freshTag, ledgerOf, newFixture } from "../support/world.ts";
import type { Fixture } from "../support/world.ts";
import { SYNTHETIC_ID_START, cloudWorld } from "./cloudWorld.ts";
import { personalDataIn } from "./privacy.ts";
import {
  awaitInstance,
  createInstance,
  describeSteps,
  isTerminal,
  stepNamed,
  stopThroughWorker,
} from "./workflowsApi.ts";

const POLL = { every: "5 seconds", timeout: "4 minutes" } as const;
const LONG_POLL = { every: "10 seconds", timeout: "6 minutes" } as const;

/** Epoch milliseconds of an instant that the API reported, or `undefined` when it reported none. */
const millisOf = (instant: string | null | undefined): number | undefined =>
  Option.getOrUndefined(
    Option.map(DateTime.make(instant ?? ""), DateTime.toEpochMillis)
  );

/** A value the API must have reported; its absence fails the test and names what was missing. */
const required = <A>(value: A | undefined, what: string): A =>
  value ?? assert.fail(`the API reported no ${what}`);

/** A synthetic person with a membership to renew, and the ids of its renewal. The ids are checked to be synthetic. */
const newRenewal = Effect.fn("cloud.newRenewal")(function* newRenewal(
  prefix: string
) {
  const tag = yield* freshTag;
  const fixture = yield* newFixture(tag);
  const renewalId = `${prefix}-${tag}`;

  assert.isTrue(
    Arr.every(
      [fixture.personId, fixture.membershipId, fixture.departmentId],
      (id) => id >= SYNTHETIC_ID_START
    ),
    "the fixture's ids are in the synthetic range"
  );

  return {
    commandId: extendCommandId(RenewalIdSchema.make(renewalId)),
    fixture,
    renewalId,
  };
});

/**
 * (d) Keeps the API's JSON of the finished instance in the evidence directory, and checks that it, the answer to the
 * create call and the answer to any stop event name ids and instants only.
 */
const keepEvidenceAndScan = Effect.fn("cloud.keepEvidenceAndScan")(
  function* keepEvidenceAndScan(
    name: string,
    instanceJson: string,
    otherJson: readonly string[],
    fixture: Fixture
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Config.String("CLOUD_EVIDENCE_DIR");

    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, `${name}.json`),
      instanceJson
    );

    const found = personalDataIn(
      Arr.join([instanceJson, ...otherJson], "\n"),
      fixture.personalData
    );

    yield* Effect.logInfo(`${name}: privacy scan of the Workflows API's JSON`, {
      bytesScanned: instanceJson.length,
      found: found.length,
      markersSearched: fixture.personalData.length,
    });
    assert.deepStrictEqual(found, []);
  }
);

/**
 * A stop before the date, sent from the Worker through the Workflows binding (the test-only stopper: `cf` cannot send an
 * event) as the product's stop link would: the renewal ends without renewing. With `named`, the event's payload names who
 * stopped it and the outcome carries that id; without, the stop is anonymous (an empty payload) and the outcome names
 * nobody.
 */
const stopBeforeTheDate = Effect.fn("cloud.stopBeforeTheDate")(
  function* stopBeforeTheDate(label: string, named: boolean) {
    const { commandId, fixture, renewalId } = yield* newRenewal(label);
    const params = yield* parametersOf(fixture, renewalId, "10 minutes");
    const dueAt = required(millisOf(params.dueAt), "due date");
    const created = yield* createInstance(WORKFLOW_NAME, renewalId, params);

    // The notice task has run and the stop wait is open: the instance is waiting for an event.
    const waiting = yield* awaitInstance(
      `(${label}) before the stop`,
      WORKFLOW_NAME,
      renewalId,
      (instance) =>
        stepNamed(instance, "stop") !== undefined ||
        instance.status === "waiting",
      POLL
    );

    yield* Effect.logInfo(
      `(${label}) before the stop`,
      describeSteps(waiting.instance)
    );

    const sentAt = yield* DateTime.now;

    const stopper = yield* stopThroughWorker(
      "first",
      renewalId,
      named ? fixture.personId : undefined
    );

    yield* Effect.logInfo(`(${label}) the stopper's steps`, {
      status: stopper.done.instance.status,
      steps: describeSteps(stopper.done.instance),
    });
    assert.strictEqual(stopper.done.instance.status, "complete");

    const done = yield* awaitInstance(
      `(${label}) after the stop`,
      WORKFLOW_NAME,
      renewalId,
      (instance) => isTerminal(instance.status),
      POLL
    );

    yield* Effect.logInfo(
      `(${label}) the instance's steps`,
      describeSteps(done.instance)
    );
    yield* keepEvidenceAndScan(label, done.raw, [created.raw], fixture);
    yield* keepEvidenceAndScan(
      `${label}-stopper`,
      stopper.done.raw,
      [stopper.created.raw],
      fixture
    );

    assert.strictEqual(done.instance.status, "complete");

    const outcome = yield* decodeOutcome(done.instance.output);

    assert.isTrue(Predicate.isTagged(outcome, "Stopped"));

    if (Predicate.isTagged(outcome, "Stopped")) {
      assert.strictEqual(outcome.renewalId, renewalId);
      assert.strictEqual(outcome.personId, fixture.personId);
      assert.strictEqual(
        outcome.stoppedBy,
        named ? fixture.personId : undefined
      );
      assert.isTrue(
        DateTime.toEpochMillis(outcome.stoppedAt) >=
          DateTime.toEpochMillis(sentAt) - 60_000
      );
      assert.isTrue(DateTime.toEpochMillis(outcome.stoppedAt) < dueAt);
    }

    // No renewal: the instance never ran the extend task, and Neon has no receipt and no event for the command.
    assert.isUndefined(stepNamed(done.instance, "extend-membership"));

    const ledger = yield* ledgerOf(fixture, commandId, renewalId);

    yield* Effect.logInfo(`(${label}) the command's ledger in Neon`, ledger);
    assert.deepStrictEqual(ledger, {
      extensions: 0,
      notices: 1,
      projectedEnd: fixture.end,
      receipts: 0,
    });

    // Observed, not asserted: a second stop, sent after the instance has decided. The stopper's send task reports what
    // the engine does with an event for an instance that has finished.
    const late = yield* stopThroughWorker("late", renewalId);

    yield* Effect.logInfo(`(${label}) a stop sent after the instance decided`, {
      error: late.done.instance.error ?? null,
      status: late.done.instance.status,
      steps: describeSteps(late.done.instance),
    });
    yield* keepEvidenceAndScan(
      `${label}-late-stopper`,
      late.done.raw,
      [late.created.raw],
      fixture
    );
  }
);

layer(Layer.mergeAll(cloudWorld, nodeServicesLayer), {
  excludeTestServices: true,
  timeout: "20 minutes",
})(
  "the deployed renewal workflow (Cloudflare Workflows + Hyperdrive + Neon)",
  (it) => {
    it.effect(
      "(0) the tests reach a throwaway branch as its owner, and the Worker's role can write the spike's tables",
      () =>
        Effect.gen(function* branchPreconditions() {
          const sql = yield* SqlClient;

          const [identity] = yield* sql<{
            readonly database: string;
            readonly role: string;
          }>`select current_user as role, current_database() as database`;

          const [grants] = yield* sql<{
            readonly aggregate: boolean;
            readonly notice: boolean;
          }>`select has_table_privilege('vp_app', 'alchemy_aggregate', 'INSERT') as aggregate,
                  has_table_privilege('vp_app', 'spike_renewal_notice', 'INSERT') as notice`;

          yield* Effect.logInfo("(0) the branch", { grants, identity });
          assert.strictEqual(identity?.role, "neondb_owner");
          assert.deepStrictEqual(grants, { aggregate: true, notice: true });
        })
    );

    it.effect(
      "(a)+(d) a task that fails after its command committed is retried natively and the command stays one",
      () =>
        Effect.gen(function* retryAndDedupe() {
          const { commandId, fixture, renewalId } = yield* newRenewal("retry");

          const params = {
            ...(yield* parametersOf(fixture, renewalId, "20 seconds")),
            fault: "failAfterCommitOnce",
          } as const;

          const created = yield* createInstance(
            WORKFLOW_NAME,
            renewalId,
            params
          );

          const done = yield* awaitInstance(
            "(a)",
            WORKFLOW_NAME,
            renewalId,
            (instance) => isTerminal(instance.status),
            POLL
          );

          yield* Effect.logInfo(
            "(a) the instance's steps",
            describeSteps(done.instance)
          );
          yield* keepEvidenceAndScan("retry", done.raw, [created.raw], fixture);

          assert.strictEqual(done.instance.status, "complete");

          const outcome = yield* decodeOutcome(done.instance.output);

          assert.isTrue(Predicate.isTagged(outcome, "Renewed"));

          if (Predicate.isTagged(outcome, "Renewed")) {
            assert.strictEqual(outcome.attempt, 2);
            assert.strictEqual(outcome.commandId, commandId);
            assert.strictEqual(outcome.version, 2);
          }

          // The native retry: the extend task ran twice, the first attempt failed after its commit.
          const attempts = required(
            stepNamed(done.instance, "extend-membership")?.attempts ??
              undefined,
            "attempts of the extend step"
          );

          assert.deepStrictEqual(
            Arr.map(attempts, (attempt) => attempt.success),
            [false, true]
          );

          // One command: one receipt, one event, the projection moved once, the notice queued once.
          const ledger = yield* ledgerOf(fixture, commandId, renewalId);

          yield* Effect.logInfo("(a) the command's ledger in Neon", ledger);
          assert.deepStrictEqual(ledger, {
            extensions: 1,
            notices: 1,
            projectedEnd: fixture.extendedEnd,
            receipts: 1,
          });
        })
    );

    it.effect(
      "(c)+(d) a stop sent from the Worker through the Workflows binding, naming who stopped it, ends the instance without renewing",
      () => stopBeforeTheDate("stop", true)
    );

    it.effect(
      "(g)+(d) an anonymous stop (an empty event payload) ends the instance without renewing, and the outcome names nobody",
      () => stopBeforeTheDate("anon", false)
    );

    it.effect(
      "(e)+(d) with no stop event the wait times out at the date: the instance wakes, renews once and completes",
      () =>
        Effect.gen(function* timeoutWakes() {
          const { commandId, fixture, renewalId } = yield* newRenewal("wake");
          const params = yield* parametersOf(fixture, renewalId, "150 seconds");
          const dueAt = required(millisOf(params.dueAt), "due date");

          const created = yield* createInstance(
            WORKFLOW_NAME,
            renewalId,
            params
          );

          const done = yield* awaitInstance(
            "(e)",
            WORKFLOW_NAME,
            renewalId,
            (instance) => isTerminal(instance.status),
            LONG_POLL
          );

          yield* Effect.logInfo(
            "(e) the instance's steps",
            describeSteps(done.instance)
          );
          yield* keepEvidenceAndScan("wake", done.raw, [created.raw], fixture);

          assert.strictEqual(done.instance.status, "complete");

          const outcome = yield* decodeOutcome(done.instance.output);

          assert.isTrue(Predicate.isTagged(outcome, "Renewed"));

          if (Predicate.isTagged(outcome, "Renewed")) {
            assert.strictEqual(outcome.attempt, 1);
            assert.strictEqual(outcome.version, 2);
          }

          // The wake is the date: the wait ended at it (the clock is absolute), and the extend task followed.
          const wait = required(stepNamed(done.instance, "stop"), "stop wait");

          const extend = required(
            stepNamed(done.instance, "extend-membership"),
            "extend step"
          );

          const waitEnd = required(millisOf(wait.end), "end of the stop wait");

          const extendStart = required(
            millisOf(extend.start),
            "start of the extend step"
          );

          yield* Effect.logInfo("(e) the wake", {
            extendStartAfterWaitEndMs: extendStart - waitEnd,
            waitEndAfterDueAtMs: waitEnd - dueAt,
          });
          assert.isTrue(
            waitEnd >= dueAt - 2000,
            "the wait did not end before the date"
          );
          assert.isTrue(
            extendStart >= waitEnd - 1000,
            "the extend task followed the wait"
          );
          assert.isUndefined(stepNamed(done.instance, "renewal-date"));

          const ledger = yield* ledgerOf(fixture, commandId, renewalId);

          yield* Effect.logInfo("(e) the command's ledger in Neon", ledger);
          assert.deepStrictEqual(ledger, {
            extensions: 1,
            notices: 1,
            projectedEnd: fixture.extendedEnd,
            receipts: 1,
          });
        })
    );

    it.effect(
      "(f)+(d) a stop window that closes early leaves a real sleepUntil to the date, a stop inside the sleep is not heard, and the renewal commits once",
      () =>
        Effect.gen(function* sleepsToTheDate() {
          const { commandId, fixture, renewalId } = yield* newRenewal("sleep");
          const now = yield* DateTime.now;

          const params = {
            ...(yield* parametersOf(fixture, renewalId, "150 seconds")),
            stopUntil: DateTime.formatIso(
              DateTime.addDuration(now, "30 seconds")
            ),
          } as const;

          const dueAt = required(millisOf(params.dueAt), "due date");

          const stopUntil = required(
            millisOf(params.stopUntil),
            "end of the stop window"
          );

          const created = yield* createInstance(
            WORKFLOW_NAME,
            renewalId,
            params
          );

          // The window closes thirty seconds in; the instance then sleeps until the date.
          const sleeping = yield* awaitInstance(
            "(f) until the sleep starts",
            WORKFLOW_NAME,
            renewalId,
            (instance) => stepNamed(instance, "renewal-date") !== undefined,
            POLL
          );

          yield* Effect.logInfo(
            "(f) the sleep has started",
            describeSteps(sleeping.instance)
          );

          // A stop inside the sleep, sent from the Worker through the binding: nothing waits for it any more, so the engine
          // may accept it (it is never read) or refuse it; the renewal commits either way.
          const inSleep = yield* stopThroughWorker(
            "insleep",
            renewalId,
            fixture.personId
          );

          yield* Effect.logInfo("(f) a stop sent while the instance sleeps", {
            error: inSleep.done.instance.error ?? null,
            status: inSleep.done.instance.status,
            steps: describeSteps(inSleep.done.instance),
          });

          const done = yield* awaitInstance(
            "(f) until the end",
            WORKFLOW_NAME,
            renewalId,
            (instance) => isTerminal(instance.status),
            LONG_POLL
          );

          yield* Effect.logInfo(
            "(f) the instance's steps",
            describeSteps(done.instance)
          );
          yield* keepEvidenceAndScan("sleep", done.raw, [created.raw], fixture);
          yield* keepEvidenceAndScan(
            "sleep-insleep-stopper",
            inSleep.done.raw,
            [inSleep.created.raw],
            fixture
          );

          assert.strictEqual(done.instance.status, "complete");

          const outcome = yield* decodeOutcome(done.instance.output);

          assert.isTrue(Predicate.isTagged(outcome, "Renewed"));

          const wait = required(stepNamed(done.instance, "stop"), "stop wait");

          const sleep = required(
            stepNamed(done.instance, "renewal-date"),
            "sleep step"
          );

          const extend = required(
            stepNamed(done.instance, "extend-membership"),
            "extend step"
          );

          const waitEnd = required(millisOf(wait.end), "end of the stop wait");
          const sleepEnd = required(millisOf(sleep.end), "end of the sleep");

          const extendStart = required(
            millisOf(extend.start),
            "start of the extend step"
          );

          yield* Effect.logInfo("(f) the instants", {
            extendStartAfterSleepEndMs: extendStart - sleepEnd,
            sleepEndAfterDueAtMs: sleepEnd - dueAt,
            waitEndAfterStopUntilMs: waitEnd - stopUntil,
          });

          // The wait ended with the window, far before the date; the sleep ended at the date; the task followed.
          assert.isTrue(
            waitEnd >= stopUntil - 2000,
            "the stop wait did not end before its window closed"
          );
          assert.isTrue(
            waitEnd < dueAt - 60_000,
            "the stop wait ended with the window, not with the date"
          );
          assert.isTrue(
            sleepEnd >= dueAt - 2000,
            "the sleep did not end before the date"
          );
          assert.isTrue(
            extendStart >= sleepEnd - 1000,
            "the extend task followed the sleep"
          );

          const ledger = yield* ledgerOf(fixture, commandId, renewalId);

          yield* Effect.logInfo("(f) the command's ledger in Neon", ledger);
          assert.deepStrictEqual(ledger, {
            extensions: 1,
            notices: 1,
            projectedEnd: fixture.extendedEnd,
            receipts: 1,
          });
        })
    );
  }
);
