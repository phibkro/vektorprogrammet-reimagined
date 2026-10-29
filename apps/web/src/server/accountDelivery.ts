/** Interprets account outbox intents after domain commit. */
import {
  AccountRepository,
  AggregateLocks,
  CodeRepository,
  OutboxDelivery,
  OutboxMessage,
  PersonRepository,
  PersonalDataDeclaration,
  SiteOrigin,
  Transactor,
  codePolicy,
  lifetimeWords,
  mintCode,
} from "@vektorprogrammet/domain";
import type {
  Account,
  ClaimedOutboxMessage,
  CodeHash,
  OutboxAck,
  TransportMessage,
} from "@vektorprogrammet/domain";
import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
} from "effect";

import { Auth } from "./auth";
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

/** What transaction 1 hands on: the row is settled there, or a code is stored and its mail waits in memory. */
type Prepared = Data.TaggedEnum<{
  Settled: { readonly ack: OutboxAck };
  Stored: {
    readonly hash: CodeHash;
    readonly mail: Redacted.Redacted<TransportMessage>;
  };
}>;

const preparedAs = Data.taggedEnum<Prepared>();

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

    /**
     * Transaction 1: lock the person, decide that a code is still due, mint it and store its hash `Unsent`. Nothing is
     * sent here, and the port that sends refuses a call made inside this transaction (spec 0024 R6). Either the row is
     * settled here (nothing to send: the person or the account is gone) or the mail is built, with the plaintext link, and
     * handed on in memory; the plaintext is in no table and in no log (a `Redacted` value does not print).
     */
    const store = Effect.fn("AccountDelivery.storeCode")(function* store(
      row: ClaimedOutboxMessage,
      message: CodeIntent
    ) {
      return yield* transactor.run(
        Effect.gen(function* mintAndStore() {
          const locked = yield* locks
            .lock("Person", message.personId)
            .pipe(Effect.option);

          if (Option.isNone(locked)) {
            return preparedAs.Settled({
              ack: yield* delivery.markDelivered(row.id, row.claimToken),
            });
          }

          // The fence: only the consumer that still holds the row's claim writes a code (spec 0024 R9). A consumer whose
          // lease lapsed while it waited for the person's lock finds another consumer's claim, or the row delivered,
          // and writes nothing: it would replace a code that the other one delivered. The lock on the person came first,
          // so the order is that of transaction 2 (person, then row).
          if (
            (yield* delivery.holdClaim(row.id, row.claimToken)) === "claimLost"
          ) {
            return preparedAs.Settled({ ack: "claimLost" });
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
            return preparedAs.Settled({
              ack: yield* delivery.markDelivered(row.id, row.claimToken),
            });
          }

          const now = yield* DateTime.now;

          const { token, hash } = yield* mintCode().pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.orDie
          );

          yield* codes.issue(locked.value, {
            expiresAt: DateTime.add(now, { seconds: policy.lifetimeSeconds }),
            hash,
            purpose: message.purpose,
          });

          const presentation = codeMail[message.purpose];
          const link = `${origin}${presentation.path}?kode=${token}`;

          return preparedAs.Stored({
            hash,
            mail: Redacted.make(
              OutboxMessage.cases.Email.make({
                replyTo: null,
                subject: presentation.subject,
                text: presentation.text(
                  link,
                  lifetimeWords(policy.lifetimeSeconds, "no")
                ),
                to: recipient.email,
              })
            ),
          });
        })
      );
    });

    /**
     * Transaction 2, after the mail went out: `Unsent → Usable` for the code of this attempt, and the row delivered, in one
     * commit. The acknowledgement is bound to the code's hash and does not depend on the claim: a code that a newer
     * attempt replaced, or that the person's erasure removed, is not there to acknowledge (nothing changes), and one that
     * is still the person's current code is as good as its mail, whoever holds the row now. So when the claim was lost
     * meanwhile the acknowledgement still commits and the answer is `claimLost`; the row is the other consumer's (spec
     * 0024 R9, decision D5). The row is delivered here only while the claim is current.
     */
    const acknowledge = Effect.fn("AccountDelivery.acknowledgeCode")(
      function* acknowledge(
        row: ClaimedOutboxMessage,
        message: CodeIntent,
        hash: CodeHash
      ) {
        return yield* transactor
          .run(
            Effect.gen(function* makeUsable() {
              const locked = yield* locks
                .lock("Person", message.personId)
                .pipe(Effect.option);

              if (Option.isSome(locked)) {
                yield* codes.acknowledge(locked.value, {
                  hash,
                  purpose: message.purpose,
                });
              }

              return yield* delivery.markDelivered(row.id, row.claimToken);
            })
          )
          .pipe(Effect.uninterruptible);
      }
    );

    /**
     * Mint, send, acknowledge: two transactions with the send between them (spec 0024). The send is at least once: a
     * crash after the provider answered and before transaction 2 leaves the code `Unsent`, so the mail's link refuses,
     * and the claim's lease runs out and the row is delivered again, which issues a new code and mails it.
     */
    const issueCode = Effect.fn("AccountDelivery.issueCode")(
      function* issueCode(row: ClaimedOutboxMessage, message: CodeIntent) {
        const prepared = yield* store(row, message);

        if (Predicate.isTagged(prepared, "Settled")) {
          return prepared.ack;
        }

        // Provider errors may contain request data: never persist or log them with a code. Each attempt mints a new
        // code, so its mail is its own message: the key is the row and the attempt, not the row alone.
        yield* sender
          .send(Redacted.value(prepared.mail), `${row.id}.${row.attempts}`)
          .pipe(
            Effect.mapError(
              () => new DeliveryFailed({ reason: "code email delivery failed" })
            )
          );

        return yield* acknowledge(row, message, prepared.hash);
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
