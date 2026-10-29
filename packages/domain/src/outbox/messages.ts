/**
 * The catalog of the outbox: every message that a service declares it enqueues, as the one union that delivery decodes
 * (ADR 0015 stage 3, operator resolution 3, spec 0022 R5). A service declares its messages (`declareMessage`, in its own
 * module); this lists them, so a module that enqueues nothing of another service's does not know its messages, and the
 * library `Outbox` names none. `test/outbox/messages.test.ts` fails on a declared message that is not listed here, and
 * on one listed that nobody declares.
 *
 * The order is the order of the `outbox.kind` check (`packages/db/src/schema.ts` reads `OutboxMessage.cases`).
 */
import { Schema } from "effect";

import {
  IssueCodeMessage,
  SetCredentialMessage,
} from "../accounts/messages.ts";
import { EmailMessage, SlackPostMessage } from "../shared/outbox.ts";
import { WorkspaceChangeMessage } from "../workspace/message.ts";

/** Persisted as JSON by `packages/db`; decode with this schema on read. */
export const OutboxMessage = Schema.Union([
  EmailMessage,
  IssueCodeMessage,
  SetCredentialMessage,
  SlackPostMessage,
  WorkspaceChangeMessage,
]).pipe(Schema.toTaggedUnion("_tag"));

export type OutboxMessage = typeof OutboxMessage.Type;

/**
 * Whether a declared message is one that the catalog lists. The database adapter encodes with `OutboxMessage` (an
 * unlisted message is a defect there); an `Outbox` that keeps its rows in memory narrows with this.
 */
export const isListed = Schema.is(OutboxMessage);
