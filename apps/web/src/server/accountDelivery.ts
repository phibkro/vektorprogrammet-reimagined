/** Interprets account outbox intents after domain commit. */
import { OutboxDelivery } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage, OutboxAck } from "@vektorprogrammet/db";
import {
  AccountRepository,
  AggregateLocks,
  CodeRepository,
  OutboxMessage,
  PersonRepository,
  PersonalDataDeclaration,
  SiteOrigin,
  Transactor,
  codePolicy,
  lifetimeWords,
  mintCode,
} from "@vektorprogrammet/domain";
import type { Account } from "@vektorprogrammet/domain";
import { Context, Crypto, DateTime, Effect, Layer, Option } from "effect";

import { Auth } from "./auth";
import { DeliveryClaimLost } from "./deliveryClaimLost";
import { DeliveryFailed, MessageSender } from "./senders";

type CodeIntent = Extract<OutboxMessage, { readonly _tag: "IssueCode" }>;

type CredentialIntent = Extract<
  OutboxMessage,
  { readonly _tag: "SetCredential" }
>;

/** The wording of each purpose's mail; the link is the purpose's page and `?kode=`, and the lifetime is spelled from the policy by `lifetimeWords`. */
const codeMail = {
  activation: {
    path: "/aktiver",
    subject: "Aktiver kontoen din",
    text: (link: string) => `Aktiver kontoen: ${link}`,
  },
  alumniConsent: {
    path: "/alumni",
    subject: "To spørsmål om opplysningene dine",
    text: (link: string, lifetime: string) =>
      `Du er ikke lenger medlem eller assistent i Vektorprogrammet. Vi vil gjerne spørre deg om to ting som gjelder opplysningene dine. Svar med ett klikk på hvert spørsmål: ${link}\n\nLenken virker i ${lifetime}, og du kan endre svaret så lenge den virker. Du trenger ikke svare.`,
  },
  resetPassword: {
    path: "/tilbakestill-passord",
    subject: "Tilbakestill passordet ditt",
    text: (link: string) => `Velg et nytt passord: ${link}`,
  },
} as const;

/** The account that a purpose needs, if it needs one: `null` needs none (an alumnus may have no account). */
const accountFits = (
  needed: "Active" | "Invited" | null,
  account: Option.Option<Account>
): boolean =>
  needed === null ||
  Option.exists(account, (found) => found.state._tag === needed);

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
    const transactor = yield* Transactor;
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
        return yield* transactor
          .run(
            Effect.gen(function* mintSendAndAcknowledge() {
              const locked = yield* locks
                .lock("Person", message.personId)
                .pipe(Effect.option);

              if (Option.isNone(locked)) {
                return yield* delivery.markDelivered(row.id, row.claimToken);
              }

              const account = yield* accounts.findLocked(locked.value);
              const recipient = yield* people.findLocked(locked.value);
              const policy = codePolicy[message.purpose];

              // Nothing is sent when the purpose's account is not there any more, or the person was erased meanwhile:
              // anonymisation leaves an address that cannot receive mail.
              if (
                !accountFits(policy.account, account) ||
                PersonalDataDeclaration.isAnonymisedEmail(recipient.email)
              ) {
                return yield* delivery.markDelivered(row.id, row.claimToken);
              }

              const now = yield* DateTime.now;

              const { token, hash } = yield* mintCode().pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.orDie
              );

              yield* codes.replace(locked.value, {
                expiresAt: DateTime.add(now, {
                  seconds: policy.lifetimeSeconds,
                }),
                hash,
                purpose: message.purpose,
              });

              const presentation = codeMail[message.purpose];
              const link = `${origin}${presentation.path}?kode=${token}`;

              const email = OutboxMessage.cases.Email.make({
                replyTo: null,
                subject: presentation.subject,
                text: presentation.text(
                  link,
                  lifetimeWords(policy.lifetimeSeconds, "no")
                ),
                to: recipient.email,
              });

              // Provider errors may contain request data: never persist or log them with a code. Each attempt mints a
              // new code, so its mail is its own message: the key is the row and the attempt, not the row alone.
              yield* sender.send(email, `${row.id}.${row.attempts}`).pipe(
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
          )
          .pipe(
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
