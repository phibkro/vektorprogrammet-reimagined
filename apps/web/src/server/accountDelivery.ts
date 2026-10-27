/** Interprets account outbox intents after domain commit. */
import { OutboxDelivery, transactional } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage, OutboxAck } from "@vektorprogrammet/db";
import {
  AccountRepository,
  AggregateLocks,
  CodeRepository,
  OutboxMessage,
  PersonRepository,
  SiteOrigin,
  codePolicy,
  mintCode,
} from "@vektorprogrammet/domain";
import { Context, Crypto, DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Auth } from "./auth";
import { DeliveryClaimLost } from "./deliveryClaimLost";
import { DeliveryFailed, MessageSender } from "./senders";

type CodeIntent = Extract<OutboxMessage, { readonly _tag: "IssueCode" }>;

type CredentialIntent = Extract<
  OutboxMessage,
  { readonly _tag: "SetCredential" }
>;

const codeMail = {
  activation: {
    expectedState: "Invited",
    path: "/aktiver",
    subject: "Aktiver kontoen din",
    verb: "Aktiver kontoen",
  },
  resetPassword: {
    expectedState: "Active",
    path: "/tilbakestill-passord",
    subject: "Tilbakestill passordet ditt",
    verb: "Velg et nytt passord",
  },
} as const;

export class AccountDelivery extends Context.Service<
  AccountDelivery,
  {
    readonly issueCode: (
      row: ClaimedOutboxMessage,
      message: CodeIntent
    ) => Effect.Effect<OutboxAck, DeliveryFailed>;
    readonly setCredential: (
      row: ClaimedOutboxMessage,
      message: CredentialIntent
    ) => Effect.Effect<void, DeliveryFailed>;
  }
>()("@vektorprogrammet/web/server/AccountDelivery") {}

/** The Layer owns no pool: it captures the delivery scope's database, auth adapter, crypto and sender. */
export const accountDeliveryLayer = Layer.effect(
  AccountDelivery,
  Effect.gen(function* buildAccountDelivery() {
    const sql = yield* SqlClient;
    const accounts = yield* AccountRepository;
    const codes = yield* CodeRepository;
    const locks = yield* AggregateLocks;
    const people = yield* PersonRepository;
    const sender = yield* MessageSender;
    const delivery = yield* OutboxDelivery;
    const origin = yield* SiteOrigin;
    const crypto = yield* Crypto.Crypto;
    const auth = yield* Auth;

    const issueCode = Effect.fn("AccountDelivery.issueCode")(
      function* issueCode(row: ClaimedOutboxMessage, message: CodeIntent) {
        return yield* transactional(
          Effect.gen(function* mintSendAndAcknowledge() {
            const locked = yield* locks
              .lock("Person", message.personId)
              .pipe(Effect.option);

            const account = Option.isSome(locked)
              ? yield* accounts.findLocked(locked.value)
              : Option.none();

            const presentation = codeMail[message.purpose];

            if (
              Option.isNone(locked) ||
              Option.isNone(account) ||
              account.value.state._tag !== presentation.expectedState
            ) {
              return yield* delivery.markDelivered(row.id, row.claimToken);
            }

            const recipient = yield* people.findLocked(locked.value);
            const now = yield* DateTime.now;

            const { token, hash } = yield* mintCode().pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.orDie
            );

            yield* codes.replace(locked.value, {
              expiresAt: DateTime.add(now, {
                seconds: codePolicy[message.purpose].lifetimeSeconds,
              }),
              hash,
              purpose: message.purpose,
            });

            const email = OutboxMessage.cases.Email.make({
              replyTo: null,
              subject: presentation.subject,
              text: `${presentation.verb}: ${origin}${presentation.path}?kode=${token}`,
              to: recipient.email,
            });

            // Provider errors may contain request data: never persist or log them with a code.
            yield* sender.send(email).pipe(
              Effect.mapError(
                () =>
                  new DeliveryFailed({
                    reason: "code email delivery failed",
                  })
              )
            );
            const ack = yield* delivery.markDelivered(row.id, row.claimToken);

            if (ack === "claimLost") {
              return yield* new DeliveryClaimLost();
            }

            return ack;
          })
        ).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.catchTag("DeliveryClaimLost", () =>
            Effect.succeed("claimLost" as const)
          ),
          Effect.uninterruptible
        );
      }
    );

    const setCredential = Effect.fn("AccountDelivery.setCredential")(
      function* setCredential(
        row: ClaimedOutboxMessage,
        message: CredentialIntent
      ) {
        if (message.passwordHash === null) {
          return yield* Effect.die("a pending credential intent has no hash");
        }

        return yield* auth
          .setCredential({
            at: yield* DateTime.now,
            passwordHash: message.passwordHash,
            personId: message.personId,
            revokeSessions: message.revokeSessions,
            version: Number(row.id),
          })
          .pipe(
            Effect.mapError(
              () => new DeliveryFailed({ reason: "credential delivery failed" })
            )
          );
      }
    );

    return AccountDelivery.of({ issueCode, setCredential });
  })
);
