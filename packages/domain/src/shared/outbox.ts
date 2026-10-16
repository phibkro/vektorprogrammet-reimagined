/**
 * Transactional outbox. Commands enqueue typed messages inside their
 * transaction; `apps/web` delivers them after commit (`waitUntil` plus a cron
 * sweep). Only production builds real mail/Slack transports; other deployments
 * capture messages (architecture §4).
 */
import { Context, Schema } from "effect";
import type { Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import type { OutboxMessageId } from "./ids.ts";
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

/** Persisted as jsonb by `packages/db`; decode with this schema on read. */
export const OutboxMessage = Schema.TaggedUnion({
  Email: {
    replyTo: Schema.NullOr(EmailAddress),
    subject: Schema.String,
    text: Schema.String,
    to: EmailAddress,
  },
  SlackPost: {
    target: SlackTarget,
    text: Schema.String,
  },
});

export type OutboxMessage = typeof OutboxMessage.Type;

export class Outbox extends Context.Service<
  Outbox,
  {
    /** Inserts the messages in the current transaction; returns their ids in order. */
    readonly enqueue: (
      messages: NonEmptyReadonlyArray<OutboxMessage>
    ) => Effect.Effect<readonly OutboxMessageId[]>;
  }
>()("@vektorprogrammet/domain/shared/Outbox") {}
