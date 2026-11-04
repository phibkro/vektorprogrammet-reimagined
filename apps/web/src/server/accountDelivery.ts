/** Interprets account outbox intents after domain commit. */
import {
  AccountRepository,
  AggregateLocks,
  CodeRepository,
  DeleteAuthUserMessage,
  Outbox,
  OutboxDelivery,
  OutboxMessage,
  PersonId,
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
  Schema,
} from "effect";

import { DeliveryClaimLost } from "./deliveryClaimLost";
import type { WorkerEnv } from "./env";
import { DeliveryFailed, MessageSender } from "./senders";
import { createAdminClient } from "./supabase";

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ personId: PersonId })
);

type InviteIntent = Extract<OutboxMessage, { readonly _tag: "InviteAccount" }>;

type CodeIntent = Extract<OutboxMessage, { readonly _tag: "IssueCode" }>;

type DeleteIntent = Extract<OutboxMessage, { readonly _tag: "DeleteAuthUser" }>;

type RelinkIntent = Extract<OutboxMessage, { readonly _tag: "RelinkAuthUser" }>;

/** The wording of each purpose's mail; the link is the purpose's page and `?kode=`, and the lifetime is spelled from the policy by `lifetimeWords`. */
const codeMail = {
  alumniConsent: {
    path: "/alumni",
    subject: "To spørsmål om opplysningene dine",
    text: (link: string, lifetime: string) =>
      `Du er ikke lenger medlem eller assistent i Vektorprogrammet. Vi vil gjerne spørre deg om to ting som gjelder opplysningene dine. Svar med ett klikk på hvert spørsmål: ${link}\n\nLenken virker i ${lifetime}, og du kan endre svaret så lenge den virker. Du trenger ikke svare.`,
  },
  verifyApplication: {
    path: "/soknad/bekreft",
    subject: "Bekreft e-postadressen din",
    text: (link: string, lifetime: string) =>
      `Vi har mottatt søknaden din til Vektorprogrammet. Bekreft at e-postadressen er din ved å åpne lenken og trykke på knappen: ${link}\n\nLenken virker i ${lifetime}. Har du ikke søkt, kan du se bort fra denne e-posten.`,
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
    readonly inviteAccount: (
      row: ClaimedOutboxMessage,
      message: InviteIntent
    ) => Effect.Effect<OutboxAck, DeliveryFailed>;
    readonly deleteAuthUser: (
      row: ClaimedOutboxMessage,
      message: DeleteIntent
    ) => Effect.Effect<OutboxAck, DeliveryFailed>;
    readonly relinkAuthUser: (
      row: ClaimedOutboxMessage,
      message: RelinkIntent
    ) => Effect.Effect<OutboxAck, DeliveryFailed>;
    readonly issueCode: (
      row: ClaimedOutboxMessage,
      message: CodeIntent
    ) => Effect.Effect<OutboxAck, DeliveryFailed>;
  }
>()("@vektorprogrammet/web/server/AccountDelivery") {}

/** The Layer owns no pool: it captures the delivery scope's database, auth adapter, crypto and sender. */
export const accountDeliveryLayer = (
  env: Pick<
    WorkerEnv,
    | "SUPABASE_URL"
    | "SUPABASE_PUBLISHABLE_KEY"
    | "SUPABASE_SECRET_KEY"
    | "SITE_URL"
  >
) =>
  Layer.effect(
    AccountDelivery,
    Effect.gen(function* buildAccountDelivery() {
      const admin = createAdminClient(env);
      const transactor = yield* Transactor;
      const outbox = yield* Outbox;
      const accounts = yield* AccountRepository;
      const codes = yield* CodeRepository;
      const locks = yield* AggregateLocks;
      const people = yield* PersonRepository;
      const sender = yield* MessageSender;
      const delivery = yield* OutboxDelivery;
      const origin = yield* SiteOrigin;
      const crypto = yield* Crypto.Crypto;

      // A stale acknowledgment must fail inside the transaction so its other writes roll back.
      const acknowledgeClaim = Effect.fn("AccountDelivery.acknowledgeClaim")(
        function* acknowledgeClaim(row: ClaimedOutboxMessage) {
          const ack = yield* delivery.markDelivered(row.id, row.claimToken);

          if (ack === "claimLost") {
            return yield* new DeliveryClaimLost();
          }

          return ack;
        }
      );

      const findInviteIdentity = Effect.fn(
        "AccountDelivery.findInviteIdentity"
      )(function* findInviteIdentity(
        email: Parameters<typeof accounts.findAuthIdentity>[0],
        message: InviteIntent
      ) {
        const existing = yield* accounts.findAuthIdentity(email);

        if (
          Option.isSome(existing) &&
          existing.value.personId !== message.personId &&
          (existing.value.personId !== null || !existing.value.pendingInvite)
        ) {
          return yield* new DeliveryFailed({
            reason: "provider identity conflict",
          });
        }

        return existing;
      });

      const generateInvite = Effect.fn("AccountDelivery.generateInvite")(
        function* generateInvite(
          email: Parameters<typeof accounts.findAuthIdentity>[0],
          message: InviteIntent
        ) {
          const existing = yield* findInviteIdentity(email, message);

          const generated = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({
                reason: "provider invitation generation failed",
              }),
            try: () =>
              admin.auth.admin.generateLink({
                email,
                options: { redirectTo: `${env.SITE_URL}/auth/confirm` },
                type: "invite",
              }),
          });

          if (
            generated.error !== null ||
            Option.isNone(Option.fromNullishOr(generated.data.user)) ||
            !generated.data.properties?.hashed_token
          ) {
            return yield* new DeliveryFailed({
              reason: "provider invitation generation failed",
            });
          }

          const providerId = generated.data.user.id;

          if (Option.isSome(existing) && providerId !== existing.value.id) {
            return yield* new DeliveryFailed({
              reason: "provider identity conflict",
            });
          }

          const mapped = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({
                reason: "provider identity mapping failed",
              }),
            try: () =>
              admin.auth.admin.updateUserById(providerId, {
                app_metadata: { personId: message.personId },
              }),
          });

          if (mapped.error !== null) {
            return yield* new DeliveryFailed({
              reason: "provider identity mapping failed",
            });
          }

          return { providerId, token: generated.data.properties.hashed_token };
        }
      );

      const inviteAccount = Effect.fn("AccountDelivery.inviteAccount")(
        function* inviteAccount(
          row: ClaimedOutboxMessage,
          message: InviteIntent
        ) {
          const person = yield* people
            .findById(message.personId)
            .pipe(Effect.option);

          const account = yield* accounts.find(message.personId);

          if (
            Option.isNone(person) ||
            !Option.exists(account, (value) =>
              Predicate.isTagged(value.state, "Invited")
            ) ||
            PersonalDataDeclaration.isAnonymisedEmail(person.value.email)
          ) {
            return yield* delivery.markDelivered(row.id, row.claimToken);
          }

          const { email } = person.value;
          const { providerId, token } = yield* generateInvite(email, message);
          // Erasure or an email change can commit while the provider call is in flight.
          // Recheck under the Person lock, and durably compensate before acknowledging.

          const eligibility = yield* transactor
            .run(
              Effect.gen(function* recheckInvite() {
                const locked = yield* locks
                  .lock("Person", message.personId)
                  .pipe(Effect.option);

                if (Option.isSome(locked)) {
                  const currentPerson = yield* people.findLocked(locked.value);

                  const currentAccount = yield* accounts.findLocked(
                    locked.value
                  );

                  if (
                    currentPerson.email === email &&
                    !PersonalDataDeclaration.isAnonymisedEmail(
                      currentPerson.email
                    ) &&
                    Option.exists(currentAccount, (value) =>
                      Predicate.isTagged(value.state, "Invited")
                    )
                  ) {
                    return "send" as const;
                  }
                }

                yield* outbox.enqueue([
                  DeleteAuthUserMessage.make({ userId: providerId }),
                ]);

                const ack = yield* delivery.markDelivered(
                  row.id,
                  row.claimToken
                );

                if (ack === "claimLost") {
                  return yield* new DeliveryClaimLost();
                }

                return "recorded" as const;
              })
            )
            .pipe(
              Effect.catchTag("DeliveryClaimLost", () =>
                Effect.succeed("claimLost" as const)
              )
            );

          if (eligibility !== "send") {
            return eligibility;
          }

          const link = `${env.SITE_URL}/auth/confirm?token_hash=${encodeURIComponent(token)}&type=invite`;
          yield* sender
            .send(
              OutboxMessage.cases.Email.make({
                replyTo: null,
                subject: "Aktiver kontoen din",
                text: `Følg lenken for å velge et passord og aktivere kontoen din: ${link}`,
                to: email,
              }),
              `${row.id}.${row.attempts}`
            )
            .pipe(
              Effect.mapError(
                () =>
                  new DeliveryFailed({
                    reason: "provider invitation delivery failed",
                  })
              )
            );

          return yield* delivery.markDelivered(row.id, row.claimToken);
        }
      );

      const deleteAuthUser = Effect.fn("AccountDelivery.deleteAuthUser")(
        function* deleteAuthUser(
          row: ClaimedOutboxMessage,
          message: DeleteIntent
        ) {
          const result = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({ reason: "provider deletion failed" }),
            try: () => admin.auth.admin.deleteUser(message.userId),
          });

          if (result.error !== null && result.error.status !== 404) {
            return yield* new DeliveryFailed({
              reason: "provider deletion failed",
            });
          }

          return yield* delivery.markDelivered(row.id, row.claimToken);
        }
      );

      const finishRelink = (row: ClaimedOutboxMessage, message: RelinkIntent) =>
        transactor
          .run(
            Effect.gen(function* finishRelinkInTransaction() {
              const locked = yield* locks
                .lock("Person", message.into)
                .pipe(Effect.option);

              if (Option.isNone(locked)) {
                yield* outbox.enqueue([
                  DeleteAuthUserMessage.make({ userId: message.userId }),
                ]);
              } else {
                const account = yield* accounts.findLocked(locked.value);
                const person = yield* people.findLocked(locked.value);

                if (
                  Option.isNone(account) ||
                  PersonalDataDeclaration.isAnonymisedEmail(person.email)
                ) {
                  yield* outbox.enqueue([
                    DeleteAuthUserMessage.make({ userId: message.userId }),
                  ]);
                }
              }

              return yield* acknowledgeClaim(row);
            })
          )
          .pipe(
            Effect.catchTag("DeliveryClaimLost", () =>
              Effect.succeed("claimLost" as const)
            )
          );

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
              (yield* delivery.holdClaim(row.id, row.claimToken)) ===
              "claimLost"
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
                () =>
                  new DeliveryFailed({ reason: "code email delivery failed" })
              )
            );

          return yield* acknowledge(row, message, prepared.hash);
        }
      );

      const ensureRelinkTargetFree = Effect.fn(
        "AccountDelivery.ensureRelinkTargetFree"
      )(function* ensureRelinkTargetFree(message: RelinkIntent) {
        const existing = yield* accounts.findAuthIdentitiesByPersonId(
          message.into
        );

        if (existing.length > 0) {
          return yield* new DeliveryFailed({
            reason: "provider identity conflict",
          });
        }

        return true;
      });

      const relinkProvider = Effect.fn("AccountDelivery.relinkProvider")(
        function* relinkProvider(message: RelinkIntent) {
          const result = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({ reason: "provider identity lookup failed" }),
            try: () => admin.auth.admin.getUserById(message.userId),
          });

          if (
            result.error !== null ||
            Option.isNone(Option.fromNullishOr(result.data.user))
          ) {
            return yield* new DeliveryFailed({
              reason: "provider identity lookup failed",
            });
          }

          const current = decodeMetadata(result.data.user.app_metadata);

          if (
            Option.exists(
              current,
              (metadata) => metadata.personId === message.into
            )
          ) {
            return true;
          }

          if (
            !Option.exists(
              current,
              (metadata) => metadata.personId === message.from
            )
          ) {
            return yield* new DeliveryFailed({
              reason: "provider identity conflict",
            });
          }

          yield* ensureRelinkTargetFree(message);

          const updated = yield* Effect.tryPromise({
            catch: () =>
              new DeliveryFailed({ reason: "provider identity relink failed" }),
            try: () =>
              admin.auth.admin.updateUserById(message.userId, {
                app_metadata: { personId: message.into },
              }),
          });

          if (updated.error !== null) {
            return yield* new DeliveryFailed({
              reason: "provider identity relink failed",
            });
          }

          return true;
        }
      );

      const relinkAuthUser = Effect.fn("AccountDelivery.relinkAuthUser")(
        function* relinkAuthUser(
          row: ClaimedOutboxMessage,
          message: RelinkIntent
        ) {
          yield* relinkProvider(message);

          return yield* finishRelink(row, message);
        }
      );

      return AccountDelivery.of({
        deleteAuthUser,
        inviteAccount,
        issueCode,
        relinkAuthUser,
      });
    })
  );
