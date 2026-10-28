/**
 * Transactional outbox. Commands enqueue typed messages inside their
 * transaction; `apps/web` delivers them after commit (`waitUntil` plus a cron
 * sweep). Only production builds real mail/Slack transports; other deployments
 * capture messages (architecture §4).
 */
import { Context, Match, Schema } from "effect";
import type { Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { CodePurpose } from "../accounts/code.ts";
import { PasswordHash } from "../accounts/passwordHasher.ts";
import { WorkspaceChange } from "../workspace/change.ts";
import { PersonId } from "./ids.ts";
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

/** Persisted as JSON by `packages/db`; decode with this schema on read. */
export const OutboxMessage = Schema.TaggedUnion({
  Email: {
    replyTo: Schema.NullOr(EmailAddress),
    subject: Schema.String,
    text: Schema.String,
    to: EmailAddress,
  },
  IssueCode: {
    personId: PersonId,
    purpose: CodePurpose,
  },
  SetCredential: {
    passwordHash: Schema.NullOr(PasswordHash),
    personId: PersonId,
    revokeSessions: Schema.Boolean,
  },
  SlackPost: {
    target: SlackTarget,
    text: Schema.String,
  },
  /** A change to the Google Workspace directory (spec 0008): delivered by the sweep to `WorkspaceWriter`, not a transport message. */
  WorkspaceChange: {
    change: WorkspaceChange,
  },
});

export type OutboxMessage = typeof OutboxMessage.Type;

/** Messages handed to e-mail and Slack transports after domain intents are interpreted. */
export type TransportMessage = Extract<
  OutboxMessage,
  { readonly _tag: "Email" | "SlackPost" }
>;

export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Inserts the messages in the current transaction and returns their ids in order. It requires the transaction: a
     * message that commits apart from the writes that made it due is a message sent for a change that never was, or the
     * reverse (CL3).
     */
    readonly enqueue: (
      messages: NonEmptyReadonlyArray<OutboxMessage>
    ) => Effect.Effect<readonly OutboxMessageId[], never, InTransaction>;
  }
>()("@vektorprogrammet/domain/shared/Outbox") {}
