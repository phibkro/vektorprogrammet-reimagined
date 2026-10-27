/**
 * The membership renewal as an Alchemy Cloudflare Workflow (Effect-native form).
 *
 * ```
 * input (ids and the renewal date, and optionally the end of the stop window)
 *   │  decodeInput: strict, a stray key is a defect
 *   ▼
 * task("queue-notice")                                   a row in PostgreSQL, once per renewal, ids only
 *   ▼
 * waitForEvent("stop", renewal-stop, until stopUntil)    a stop before the window closes ends the process: Stopped
 *   │  the timeout is the end of the window: nobody stopped it
 *   ▼
 * sleepUntil("renewal-date", dueAt)                      only when the window closed before the date (stopUntil < dueAt)
 *   ▼
 * task("extend-membership", retries)                     ExtendMembership through StaffingModel on PostgreSQL
 *   ▼
 * Renewed | Refused                                      identifiers and counts only
 * ```
 *
 * Creating the instance is the notice instant: the caller schedules it (four weeks before the date in the intended
 * process; nothing here does that). The stop wait lasts from the creation instant to `stopUntil`, which is `dueAt`
 * unless a spike sets it earlier; both ends are persisted by the engine, so a replay after a restart supplies the same
 * timeout. A stop is accepted only if the engine stamped it before `stopUntil`; one stamped at or after it is ignored,
 * and nothing reads a stop once the wait has ended, so a stop after the window or after the command changes nothing.
 *
 * Everything the engine stores (parameters, step outputs, events, the outcome) is an identifier, a count, a literal or
 * an instant: `renewal.ts` is the contract and refuses anything else.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { DateTime, Effect, Match, Option, Predicate } from "effect";

import { Database } from "./database.ts";
import { TransientFailure } from "./errors.ts";
import { extendMembership, staffingLayer } from "./extendMembership.ts";
import { WORKFLOW_NAME } from "./names.ts";
import { noticeClient, queueNotice } from "./notice.ts";
import {
  Refused,
  Renewed,
  STOP_EVENT_TYPE,
  Stopped,
  decodeInput,
  decodeStop,
  decodeThrownError,
  encodeOutcome,
  isWaitTimeout,
} from "./renewal.ts";
import type { RenewalInput, RenewalInputEncoded } from "./renewal.ts";

const RETRIES = {
  retries: { backoff: "constant", delay: "1 second", limit: 3 },
} as const;

export default class RenewalWorkflow extends Cloudflare.Workflow<RenewalWorkflow>()(
  "MembershipRenewal",
  { workflowName: WORKFLOW_NAME },
  Effect.gen(function* renewalWorkflow() {
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);

    /** One attempt of the notice task. A database that cannot be reached is transient: the insert is idempotent. */
    const notice = Effect.fn("MembershipRenewal.notice")(function* notice(
      input: RenewalInput
    ) {
      const { attempt } = yield* Cloudflare.Workflows.WorkflowStepContext;
      const url = yield* database.connectionString;

      return yield* queueNotice(input).pipe(
        Effect.provide(noticeClient(url)),
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new TransientFailure({ attempt, renewalId: input.renewalId })
          )
        )
      );
    });

    /** One attempt of the extend task: the command, then (once, on request) a transient failure after the commit. */
    const extend = Effect.fn("MembershipRenewal.extend")(function* extend(
      input: RenewalInput
    ) {
      const { attempt } = yield* Cloudflare.Workflows.WorkflowStepContext;
      const url = yield* database.connectionString;

      const step = yield* extendMembership(input, attempt).pipe(
        Effect.provide(staffingLayer(url)),
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new TransientFailure({ attempt, renewalId: input.renewalId })
          )
        )
      );

      if (
        input.fault === "failAfterCommitOnce" &&
        attempt === 1 &&
        Predicate.isTagged(step, "Extended")
      ) {
        return yield* new TransientFailure({
          attempt,
          renewalId: input.renewalId,
        });
      }

      return step;
    });

    return Effect.fn("MembershipRenewal.run")(function* run(
      raw: RenewalInputEncoded
    ) {
      const input = yield* decodeInput(raw).pipe(Effect.orDie);
      const { membershipId, personId, renewalId } = input;
      const dueAtMillis = DateTime.toEpochMillis(input.dueAt);
      const stopUntil = input.stopUntil ?? input.dueAt;
      const created = yield* Cloudflare.Workflows.WorkflowEvent;

      // Both ends come from the instance, not from a clock: a replay after a restart computes the same timeout.
      const waitMillis = Math.max(
        1,
        DateTime.toEpochMillis(stopUntil) -
          DateTime.toEpochMillis(DateTime.makeUnsafe(created.timestamp))
      );

      yield* Cloudflare.Workflows.task("queue-notice", notice(input), RETRIES);

      // The engine throws a timeout error when the wait runs out, and the Alchemy wrapper turns every failure of this step
      // into a defect (`WorkflowBridge.ts`, `Effect.promise`). Here the timeout is the expected end (the renewal date
      // came); any other defect is not. The local engine names the error `WorkflowTimeoutError`; the deployed runtime's
      // error did not carry that name, so `isWaitTimeout` reads the message too.
      const stop = yield* Cloudflare.Workflows.waitForEvent("stop", {
        timeout: waitMillis,
        type: STOP_EVENT_TYPE,
      }).pipe(
        Effect.asSome,
        Effect.catchDefect((defect) =>
          isWaitTimeout(decodeThrownError(defect))
            ? Effect.succeedNone
            : Effect.die(defect)
        )
      );

      const stopInTime = Option.filter(stop, (event) =>
        DateTime.isLessThan(DateTime.makeUnsafe(event.timestamp), stopUntil)
      );

      if (Option.isSome(stopInTime)) {
        // A stop sent through the Workflows API has no payload (the Cloudflare CLI cannot send one): an anonymous stop.
        const { stoppedBy } = yield* decodeStop(
          stopInTime.value.payload ?? {}
        ).pipe(Effect.orDie);

        const stopped = {
          membershipId,
          personId,
          renewalId,
          stoppedAt: DateTime.makeUnsafe(stopInTime.value.timestamp),
        };

        return yield* encodeOutcome(
          Stopped.make(
            stoppedBy === undefined ? stopped : { ...stopped, stoppedBy }
          )
        );
      }

      // The stop window closed before the renewal date: sleep to the date. Whether to sleep comes from the instance's
      // parameters alone, never from a clock: Cloudflare's "Rules of Workflows" (Use conditional logic carefully)
      // require every condition outside a step to be deterministic, because a replay after hibernation re-runs this body.
      if (DateTime.isLessThan(stopUntil, input.dueAt)) {
        yield* Cloudflare.Workflows.sleepUntil("renewal-date", dueAtMillis);
      }

      const step = yield* Cloudflare.Workflows.task(
        "extend-membership",
        extend(input),
        RETRIES
      );

      return yield* encodeOutcome(
        Match.value(step).pipe(
          Match.tag("Extended", (extended) =>
            Renewed.make({
              attempt: extended.attempt,
              commandId: extended.commandId,
              membershipId,
              personId,
              renewalId,
              version: extended.version,
            })
          ),
          Match.tag("Refusal", (refusal) =>
            Refused.make({
              membershipId,
              personId,
              reason: refusal.reason,
              renewalId,
            })
          ),
          Match.exhaustive
        )
      );
    });
  })
) {}
