/**
 * The wire contract of the membership renewal process: what may enter the workflow engine (the instance parameters
 * and the stop event) and what leaves it (the outcome).
 *
 * Everything here is an identifier, a count, a literal or a timestamp. A name, an email address or a phone number has
 * no field, and `decodeInput` and `decodeStop` refuse unknown keys, so personal data cannot ride along: the engine
 * stores parameters, step outputs, events and the outcome in its own files, and those files must stay free of it.
 */
import { MembershipId, PersonId, Semester } from "@vektorprogrammet/domain";
import { DateTime, Option, Schema } from "effect";

/** The workflow instance id and the idempotency anchor of the renewal: one renewal, one command. */
export const RenewalIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/u)
).pipe(Schema.brand("RenewalId"));

export type RenewalId = typeof RenewalIdSchema.Type;

/**
 * A Workflows event type. Cloudflare accepts 1 to 100 letters, digits, `-` and `_`, and refuses a `.` with
 * `workflow.invalid_event_type` (Workflows docs, "Events and parameters", "Wait for events"). The local engine accepts
 * any string, so the first deployed stop (the stopper's `sendEvent` of `renewal.stop`) was refused where every local
 * run had passed. The rule is a schema, and `STOP_EVENT_TYPE` is made through it at module load, so a type that the
 * deployed engine would refuse fails the local runs too.
 */
export const WorkflowEventTypeSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/u)
).pipe(Schema.brand("WorkflowEventType"));

/** The event type that `waitForEvent` listens for and `sendEvent` delivers. */
export const STOP_EVENT_TYPE = WorkflowEventTypeSchema.make("renewal-stop");

/**
 * Test-only fault injection: the extend task commits its command and then fails once with a transient error, so the
 * native retry runs the same command again. A literal, never data about a person.
 */
export const RenewalFaultSchema = Schema.Literal("failAfterCommitOnce");

/**
 * The instance parameters. `dueAt` is the renewal date, an ISO-8601 instant. The workflow starts when the renewal is
 * scheduled (weeks before the date): it queues the notice, then waits for a stop event until the stop window closes.
 * A stop that arrives before then ends the process without renewing. The window closes at `stopUntil`, which is
 * `dueAt` unless a spike sets it earlier (a test seam, never after `dueAt`): then the workflow sleeps until `dueAt`
 * and a stop is no longer heard. At `dueAt` the command runs; nothing reads a stop after the window closed, and the
 * stop route refuses one once the instance has decided.
 * `actorId` is the person who scheduled the renewal and answers for it (the spike acts as a synthetic administrator
 * for them, `testAuthority.ts`).
 */
export const RenewalInputSchema = Schema.Struct({
  actorId: PersonId,
  dueAt: Schema.DateTimeUtcFromString,
  end: Semester,
  fault: Schema.optionalKey(RenewalFaultSchema),
  membershipId: MembershipId,
  personId: PersonId,
  renewalId: RenewalIdSchema,
  stopUntil: Schema.optionalKey(Schema.DateTimeUtcFromString),
}).check(
  Schema.makeFilter((input) =>
    input.stopUntil === undefined ||
    DateTime.isLessThanOrEqualTo(input.stopUntil, input.dueAt)
      ? undefined
      : { issue: "stopUntil is after dueAt", path: ["stopUntil"] }
  )
);

export type RenewalInput = typeof RenewalInputSchema.Type;

export type RenewalInputEncoded = typeof RenewalInputSchema.Encoded;

/**
 * The payload of the stop event: who stopped the renewal. Optional, because an anonymous stop (an empty payload) is a
 * valid stop. `cf` cannot send a Workflows event at all (its schema declares no request body, and the API refuses a
 * body-less send with 400 `[10002] workflows.api.error.body`), so the deployed run sends the stop from a Worker
 * through the Workflows binding: `stopWorkflow.ts`.
 */
export const StopPayloadSchema = Schema.Struct({
  stoppedBy: Schema.optionalKey(PersonId),
});

/**
 * The parameters of a stopper instance (`stopWorkflow.ts`, a test-only path shaped like the product's stop link, which
 * would send the event from a Worker): the renewal to stop and, optionally, who stopped it. Identifiers only.
 */
export const StopRequestSchema = Schema.Struct({
  renewalId: RenewalIdSchema,
  stoppedBy: Schema.optionalKey(PersonId),
});

export type StopRequestEncoded = typeof StopRequestSchema.Encoded;

/** What the stopper returns: the event was handed to the renewal's instance through the binding. */
export const StopSent = Schema.TaggedStruct("StopSent", {
  renewalId: RenewalIdSchema,
});

/** The refusals of the Person aggregate that make a renewal impossible, by tag. */
export const RefusalTagSchema = Schema.Literals([
  "AlreadyExists",
  "Conflict",
  "Forbidden",
  "NotFound",
  "ValidationFailed",
]);

/** The extend task ran: the command is committed (or was committed by an earlier attempt of this task). */
export const Renewed = Schema.TaggedStruct("Renewed", {
  attempt: Schema.Int,
  commandId: Schema.NonEmptyString,
  membershipId: MembershipId,
  personId: PersonId,
  renewalId: RenewalIdSchema,
  version: Schema.Int,
});

/** A stop event arrived before the stop window closed: nothing was renewed. `stoppedBy` is absent when the event had no payload. */
export const Stopped = Schema.TaggedStruct("Stopped", {
  membershipId: MembershipId,
  personId: PersonId,
  renewalId: RenewalIdSchema,
  stoppedAt: Schema.DateTimeUtcFromString,
  stoppedBy: Schema.optionalKey(PersonId),
});

/** The aggregate refused the command: a decision, not a failure, so the task does not retry it. */
export const Refused = Schema.TaggedStruct("Refused", {
  membershipId: MembershipId,
  personId: PersonId,
  reason: RefusalTagSchema,
  renewalId: RenewalIdSchema,
});

export const RenewalOutcomeSchema = Schema.Union([Renewed, Stopped, Refused]);

export type RenewalOutcome = typeof RenewalOutcomeSchema.Type;

/**
 * What the notice task returns: the notice is queued once per renewal, whatever the attempts. "Queued" is all it
 * says: no mail is sent, because this slice has no mail transport and the production outbox's message kinds are
 * declared by the domain, which the spike does not edit. Delivery is not exercised.
 */
export const NoticeQueued = Schema.TaggedStruct("NoticeQueued", {
  created: Schema.Boolean,
  renewalId: RenewalIdSchema,
});

export type NoticeStep = typeof NoticeQueued.Type;

/** The extend task's output when the aggregate accepted the command: identifiers and counts. */
export const Extended = Schema.TaggedStruct("Extended", {
  attempt: Schema.Int,
  commandId: Schema.NonEmptyString,
  version: Schema.Int,
});

/** The extend task's output when the aggregate refused it. */
export const Refusal = Schema.TaggedStruct("Refusal", {
  reason: RefusalTagSchema,
});

export const ExtendStepSchema = Schema.Union([Extended, Refusal]);

export type ExtendStep = typeof ExtendStepSchema.Type;

/** The command id of a renewal's extend command: stable across attempts, replays and restarts. */
export const extendCommandId = (renewalId: RenewalId): string =>
  `renewal:${renewalId}:extend`;

/** What the engine says when a `waitForEvent` runs out of time: the same words in the local engine and in the deployed one. */
const WAIT_TIMEOUT_MESSAGE = /^Execution timed out after \d+ms$/u;

/** An error as user code sees it when the engine throws: a message, and a name when the runtime kept one. */
const ThrownErrorSchema = Schema.Struct({
  message: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

export type ThrownError = typeof ThrownErrorSchema.Type;

/** Reads the error out of a defect, once, at the boundary: a defect that is not an error-shaped value yields nothing. */
export const decodeThrownError = Schema.decodeUnknownOption(ThrownErrorSchema);

/**
 * Whether the error of the stop wait is its timeout, which is the expected end of the wait: the renewal date came. The
 * local engine throws `WorkflowTimeoutError`, named so. The first deployed wake failed the instance with the same
 * message under the name `Error` (the Workflows API's instance error), so the name alone does not decide: the message
 * does, and the name is accepted too. Any other defect is not a timeout.
 */
export const isWaitTimeout = (thrown: Option.Option<ThrownError>): boolean =>
  Option.exists(
    thrown,
    (seen) =>
      seen.name === "WorkflowTimeoutError" ||
      WAIT_TIMEOUT_MESSAGE.test(seen.message)
  );

const strict = { onExcessProperty: "error" } as const;

/** Decodes untrusted instance parameters; an unknown key (a name, an email address) is a decode failure. */
export const decodeInput = Schema.decodeUnknownEffect(
  RenewalInputSchema,
  strict
);

/** Decodes the untrusted payload of a stop event. */
export const decodeStop = Schema.decodeUnknownEffect(StopPayloadSchema, strict);

/** Decodes the untrusted parameters of a stopper instance; an unknown key is a decode failure. */
export const decodeStopRequest = Schema.decodeUnknownEffect(
  StopRequestSchema,
  strict
);

/** Encodes what the stopper returns to the JSON shape the engine stores. */
export const encodeStopSent = Schema.encodeEffect(StopSent);

/** Encodes an outcome to the JSON shape the engine stores and the status route returns. */
export const encodeOutcome = Schema.encodeEffect(RenewalOutcomeSchema);

/** Decodes an outcome read back from the engine. */
export const decodeOutcome = Schema.decodeUnknownEffect(
  RenewalOutcomeSchema,
  strict
);

/** What the status route reports of an instance: the engine's status and, once complete, the outcome. */
export const StatusReportSchema = Schema.Struct({
  errorName: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(RenewalOutcomeSchema),
  renewalId: RenewalIdSchema,
  status: Schema.String,
});

/**
 * An event of the engine's log as the events route reports it: the type, the step, the attempt and the instant. No
 * parameters, no step output and no error message: those stay in the engine.
 */
export const EventSummarySchema = Schema.Struct({
  attempt: Schema.NullOr(Schema.Int),
  eventId: Schema.Int,
  stepName: Schema.NullOr(Schema.String),
  timestamp: Schema.Finite,
  type: Schema.String,
});

export type EventSummary = typeof EventSummarySchema.Type;

export const EventsReportSchema = Schema.Struct({
  events: Schema.Array(EventSummarySchema),
  renewalId: RenewalIdSchema,
});
