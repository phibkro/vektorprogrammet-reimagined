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
  OutboxAck,
} from "@vektorprogrammet/domain";
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
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

                return yield* acknowledgeClaim(row);
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
