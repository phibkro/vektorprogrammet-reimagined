/**
 * Transactional outbox. Commands enqueue typed messages inside their
 * transaction; `apps/web` delivers them after commit (`waitUntil` plus a cron
 * sweep). Only production builds real mail/Slack transports; other deployments
 * capture messages (architecture §4).
 *
 * This library is the pattern: the `Outbox` port, the transport messages that every service may send (an e-mail, a
 * Slack post: they name no service) and `declareMessage`, with which a service declares each message it enqueues
 * itself (`accounts/messages.ts`, `workspace/message.ts`). It lists none of them and imports no service. The catalog
 * assembles the union that delivery decodes (`outbox/messages.ts`, ADR 0015 stage 3, spec 0022).
 */
import { Context, Match, Schema } from "effect";
import type { Brand, Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import type { OutboxMessageId } from "./ids.ts";
import type { InTransaction } from "./transaction.ts";
import { EmailAddress } from "./validation.ts";

/** A Slack channel name such as `#avdeling-trondheim`. */
export const SlackChannel = Schema.String.check(
  Schema.isPattern(/^#[^\s#]{1,80}$/u, {
    expected: "a Slack channel such as #kanal",
  })
).pipe(Schema.brand("SlackChannel"));

export type SlackChannel = typeof SlackChannel.Type;

export const SlackTarget = Schema.TaggedUnion({
  /** A department's own channel. */
  DepartmentChannel: { channel: SlackChannel },
  /** The organisation-wide #notifications channel. */
  Notifications: {},
});

export type SlackTarget = typeof SlackTarget.Type;

/** The channel a Slack target names: the department's own, or the organisation-wide `#notifications`. */
export const slackChannelOf = (target: SlackTarget): string =>
  Match.value(target).pipe(
    Match.tagsExhaustive({
      DepartmentChannel: ({ channel }) => channel,
      Notifications: () => "#notifications",
    })
  );

/**
 * A message that a service declares it enqueues, built with `declareMessage`. The brand is how `Outbox.enqueue` refuses
 * a value that nobody declared; that the catalog lists it is checked by `test/outbox/messages.test.ts`.
 */
export type DeclaredMessage = Brand.Brand<"OutboxMessage"> & {
  readonly _tag: string;
};

/**
 * Declares one message of the outbox: a tag and its fields, persisted as JSON by `packages/db` (decode with the
 * catalog's `OutboxMessage` on read). The service that enqueues the message calls this where it declares its commands.
 */
export const declareMessage = <
  const Tag extends string,
  const Fields extends Schema.Struct.Fields,
>(
  tag: Tag,
  fields: Fields
) => Schema.TaggedStruct(tag, fields).pipe(Schema.brand("OutboxMessage"));

/** An e-mail, delivered by the transport (or captured, outside production). */
export const EmailMessage = declareMessage("Email", {
  replyTo: Schema.NullOr(EmailAddress),
  subject: Schema.String,
  text: Schema.String,
  to: EmailAddress,
});

/** A Slack post, delivered by the transport (or captured, outside production). */
export const SlackPostMessage = declareMessage("SlackPost", {
  target: SlackTarget,
  text: Schema.String,
});

/** Messages handed to e-mail and Slack transports after domain intents are interpreted. */
export type TransportMessage =
  | typeof EmailMessage.Type
  | typeof SlackPostMessage.Type;

export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Inserts the messages in the current transaction and returns their ids in order. It requires the transaction: a
     * message that commits apart from the writes that made it due is a message sent for a change that never was, or the
     * reverse (CL3).
     */
    readonly enqueue: (
      messages: NonEmptyReadonlyArray<DeclaredMessage>
    ) => Effect.Effect<readonly OutboxMessageId[], never, InTransaction>;
  }
>()("@vektorprogrammet/domain/shared/Outbox") {}
