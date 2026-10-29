/**
 * Spec 0024 on real PostgreSQL: code delivery outside the transaction. The sender here is the delivery's own provider
 * (behind the same guard as the real ports) with two hooks, before and after the send, so a test sees the store at the
 * two moments between the transactions and can stop the delivery there. Every code that a mail carried is parsed from
 * the mail itself, as a person would use it.
 *
 * F1  The journey: the code is committed `Unsent` before the mail leaves, its link is refused while the mail is on its
 *     way, and it works after the second transaction.
 * F2  A crash between the send and the acknowledgement (a defect, then an interruption) leaves each mailed code
 *     unusable; the redelivery mails a new code and only that one works.
 * F3  A change of the account between the two transactions: the acknowledged code is still refused at use.
 * F4  Two requests for one person: an older attempt's acknowledgement never makes the newer attempt's `Unsent` code
 *     usable (scripted), and exactly one of two concurrent attempts' mails works (100 fresh rounds).
 * F7  The ports refuse a call inside a transaction on the real stack: the delivery's sender and Better Auth, called
 *     inside `Transactor.run` on PostgreSQL, die and leave no mail; every member of `Auth` does.
 * F11 Transaction 1 is fenced by the claim: a consumer whose lease lapsed while it waited writes nothing and mails
 *     nothing, and the code that another consumer delivered stays usable (control: the same attempt without the fence
 *     replaces it, with a second mail or with no working link at all).
 *     The same holds when the other consumer has only claimed the row and delivered nothing (the token case: the
 *     status alone does not refuse; spec revision R4).
 * F12 Transaction 2 commits the hash-bound acknowledgement even when the claim was lost meanwhile (decision D5).
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  CapturedMessageStore,
  CodeToken,
  CurrentPrincipal,
  EmailAddress,
  IntegrationCalledInTransaction,
  OutboxMessage,
  OutboxMessageId,
  anonymous,
  PasswordHash,
  PersonId,
  OutboxDelivery,
  codePrincipal,
  refusingInTransaction,
} from "@vektorprogrammet/domain";
import type {
  AggregateLocks,
  PersonRepository,
  SiteOrigin,
  Transactor,
  AccountRepository,
  CodePurpose,
  CodeRepository,
  TransportMessage,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Context,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { Crypto } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  AccountDelivery,
  accountDeliveryLayer,
} from "../src/server/accountDelivery";
import { Auth } from "../src/server/auth";
import { deliverOutbox } from "../src/server/outboxDelivery";
import { MessageSender } from "../src/server/senders";
import { liveWith } from "./support/deliveryLive";
import { leaderOf } from "./support/principals";
import { transacted } from "./support/transacted";

interface Sent {
  readonly key: string;
  readonly token: CodeToken;
}

/** The services that a hook reads and writes the store with: the delivery stack's own, given to the sender's fiber alike. */
type StoreServices =
  | AccountRepository
  | CodeRepository
  | Crypto.Crypto
  | OutboxDelivery
  | SqlClient;

/** What the sender does around each send, and what it sent. A test sets the hooks and the next test starts over. */
interface Hooks {
  before: (sent: Sent) => Effect.Effect<void>;
  after: (sent: Sent) => Effect.Effect<void>;
  readonly sent: Sent[];
}

const quiet = (): Effect.Effect<void> => Effect.void;

const hooks: Hooks = { after: quiet, before: quiet, sent: [] };

const reset = Effect.sync(() => {
  hooks.before = quiet;
  hooks.after = quiet;
  hooks.sent.length = 0;
});

const withStore = Effect.map(
  Effect.context<StoreServices>(),
  (context) => (effect: Effect.Effect<void, never, StoreServices>) =>
    Effect.provideContext(effect, context)
);

const linkOf = (message: TransportMessage): CodeToken => {
  const found = Predicate.isTagged(message, "Email")
    ? /[?&]kode=(?<token>c_[A-Za-z0-9_-]{43})/u.exec(message.text)
    : null;

  assert.isNotNull(found, "the mail holds a code link");

  return CodeToken.make(found?.groups?.token ?? "");
};

/** The delivery's provider: the capture sink, behind the same guard as the real ports, with the test's two hooks. */
const controlled = Layer.effect(
  MessageSender,
  Effect.gen(function* buildControlledSender() {
    const store = yield* CapturedMessageStore;

    return MessageSender.of(
      refusingInTransaction("MessageSender", {
        send: (message: TransportMessage, key: string) =>
          Effect.gen(function* sendWithHooks() {
            const sent = { key, token: linkOf(message) };
            yield* hooks.before(sent);
            yield* store.record(message, key);
            hooks.sent.push(sent);
            yield* hooks.after(sent);
          }),
      })
    );
  })
);

const DEPARTMENT = 701;
const LEADER = 701;

const leader = leaderOf(DEPARTMENT, { personId: LEADER, teamId: DEPARTMENT });

const idRows = Schema.Array(Schema.Struct({ id: Schema.Finite }));

const stateRows = Schema.Array(Schema.Struct({ state: Schema.String }));

const emailOf = (id: number): string => `kodelc${id}@example.org`;

const outboxIds = (personId: number) =>
  Effect.gen(function* readOutboxIds() {
    const sql = yield* SqlClient;

    const rows = yield* Schema.decodeUnknownEffect(idRows)(
      yield* sql`select id from outbox where kind = 'IssueCode' and payload->>'personId' = ${String(personId)} order by id`
    );

    return Arr.map(rows, (row) => OutboxMessageId.make(String(row.id)));
  }).pipe(Effect.orDie);

const seedBase = Effect.gen(function* seedBase() {
  const sql = yield* SqlClient;
  yield* sql`insert into department (id, city, email, name, short_name) values (${DEPARTMENT}, 'Kodeby', 'kodelc@example.org', 'Kode', 'KLC') on conflict do nothing`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (${DEPARTMENT}, ${DEPARTMENT}, 'Kode', 'KLC') on conflict do nothing`;
  yield* sql`insert into person (id, name, email, field_of_study_id) values (${LEADER}, 'Leader', 'kodelcleader@example.org', ${DEPARTMENT}) on conflict do nothing`;
}).pipe(Effect.orDie);

const addPerson = (id: number) =>
  Effect.gen(function* insertPerson() {
    const sql = yield* SqlClient;
    yield* seedBase;
    yield* sql`insert into person (id, name, email, field_of_study_id) values (${id}, 'Person', ${emailOf(id)}, ${DEPARTMENT})`;
  }).pipe(Effect.orDie);

const exactly = (count: number, ids: readonly OutboxMessageId[]) =>
  ids.length === count
    ? Effect.succeed(ids)
    : Effect.die(`expected ${count} IssueCode rows, found ${ids.length}`);

/** A person with an Invited account and the one `IssueCode` message that the invitation committed. */
const invite = (id: number) =>
  Effect.gen(function* invitePerson() {
    yield* addPerson(id);

    yield* transacted(
      AccountEndpoints.createAccount({ personId: id }).pipe(
        Effect.provideService(CurrentPrincipal, leader)
      )
    );

    const [only] = yield* exactly(1, yield* outboxIds(id));

    return only ?? OutboxMessageId.make("0");
  }).pipe(Effect.orDie);

/** A person with an Active account who asks for a reset twice: two `IssueCode` messages, the older first. */
const askForResetTwice = (id: number) =>
  Effect.gen(function* askTwice() {
    const sql = yield* SqlClient;
    yield* addPerson(id);
    yield* sql`insert into account (person_id, state) values (${id}, 'Active')`;

    yield* Effect.forEach(Arr.range(1, 2), () =>
      transacted(
        AccountEndpoints.requestPasswordReset({
          email: EmailAddress.make(emailOf(id)),
        }).pipe(Effect.provideService(CurrentPrincipal, anonymous))
      )
    );

    const [older, newer] = yield* exactly(2, yield* outboxIds(id));

    return {
      newer: newer ?? OutboxMessageId.make("0"),
      older: older ?? OutboxMessageId.make("0"),
    };
  }).pipe(Effect.orDie);

/** The states of the person's codes: at most one per purpose. */
const codeStates = (personId: number) =>
  Effect.gen(function* readCodeStates() {
    const sql = yield* SqlClient;

    const rows = yield* Schema.decodeUnknownEffect(stateRows)(
      yield* sql`select state from code where subject = ${personId} order by purpose`
    );

    return Arr.map(rows, (row) => row.state);
  }).pipe(Effect.orDie);

const rowStatus = (id: OutboxMessageId) =>
  Effect.gen(function* readRow() {
    const sql = yield* SqlClient;

    const rows = yield* sql<{
      readonly last_error: string | null;
      readonly status: string;
    }>`select status, last_error from outbox where id = ${Number(id)}`;

    return { lastError: rows[0]?.last_error, status: rows[0]?.status };
  }).pipe(Effect.orDie);

/** Whether a person who presents `token` for `purpose` is let in. */
const authenticates = (token: CodeToken, purpose: CodePurpose) =>
  Effect.map(codePrincipal(token, purpose), Option.isSome);

/** The token of the `index`-th mail that the sender sent. */
const tokenAt = (index: number) =>
  Option.match(Arr.get(hooks.sent, index), {
    onNone: () => Effect.die(`no mail number ${index} was sent`),
    onSome: (sent) => Effect.succeed(sent.token),
  });

/** The lease of a claim ran out: the crashed delivery's claim no longer holds the row. */
const leaseRanOut = (id: OutboxMessageId) =>
  Effect.gen(function* expireLease() {
    const sql = yield* SqlClient;
    yield* sql`update outbox set claim_token = null, claimed_until = null where id = ${Number(id)}`;
  }).pipe(Effect.orDie);

const deliveryTag = (id: OutboxMessageId) =>
  Effect.map(deliverOutbox([id]), (results) => results[0]?._tag);

/** The answers of every delivery that failed, as a person who reads the failure would need them. */
const failuresOf = (exits: readonly Exit.Exit<unknown, unknown>[]) =>
  Arr.flatMap(exits, (exit) =>
    Exit.isFailure(exit) ? [Cause.pretty(exit.cause)] : []
  );

const ROUNDS = 100;

const isRefusal = Schema.is(IntegrationCalledInTransaction);

/** The call that a refused exit names: the exit is a defect `IntegrationCalledInTransaction`, and nothing else. */
const refusedCall = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    return "not refused";
  }

  const defect = Cause.squash(exit.cause);

  return isRefusal(defect) ? defect.call : "not the guard's defect";
};

/** What one round of two concurrent attempts left behind, as a list of what is wrong with it. */
const concurrentRound = (round: number) =>
  Effect.gen(function* oneRound() {
    yield* reset;
    const { newer, older } = yield* askForResetTwice(8000 + round);

    const exits = yield* Effect.forEach(
      [older, newer],
      (id) => Effect.exit(deliverOutbox([id])),
      { concurrency: "unbounded" }
    );

    const states = yield* codeStates(8000 + round);

    const works = yield* Effect.forEach(hooks.sent, (sent) =>
      authenticates(sent.token, "resetPassword")
    );

    const linksThatWork = Arr.filter(works, Boolean).length;

    const problems = [
      ...failuresOf(exits),
      ...(hooks.sent.length === 2 ? [] : ["not two mails"]),
      ...(linksThatWork === 1 ? [] : [`${linksThatWork} links work`]),
      ...(Arr.join(states, ",") === "Usable"
        ? []
        : [`code states ${Arr.join(states, ",")}`]),
    ];

    return Arr.map(problems, (problem) => `round ${round}: ${problem}`);
  });

/** What the delivery of `AccountDelivery` is built from. */
type DeliveryNeeds =
  | Auth
  | AccountRepository
  | AggregateLocks
  | CodeRepository
  | Crypto.Crypto
  | MessageSender
  | OutboxDelivery
  | PersonRepository
  | SiteOrigin
  | Transactor;

/** The delivery of the account flows over the same services, with an outbox whose `holdClaim` holds nothing: the fence taken out. */
const unfencedDelivery = Effect.gen(function* buildUnfenced() {
  const context = yield* Effect.context<DeliveryNeeds>();
  const real = Context.get(context, OutboxDelivery);

  const unfenced = Context.add(
    context,
    OutboxDelivery,
    OutboxDelivery.of({
      ...real,
      holdClaim: () => Effect.succeed("recorded" as const),
    })
  );

  // `Layer.fresh`: the layer that the stack was built with is shared by reference, and would hand back its own fence.
  const built = yield* Layer.build(Layer.fresh(accountDeliveryLayer)).pipe(
    Effect.provide(Layer.succeedContext(unfenced))
  );

  return Context.get(built, AccountDelivery);
}).pipe(Effect.scoped);

/**
 * Consumer A claims the row of an invitation and its lease lapses: what A still holds is the claim that another
 * consumer may now take. Both stale-consumer scenarios below start here.
 */
const lapsedClaimOf = (personId: number) =>
  Effect.gen(function* lapsedClaim() {
    yield* reset;
    const sql = yield* SqlClient;
    const id = yield* invite(personId);
    const claimed = yield* (yield* OutboxDelivery).claim(id, 120);

    if (!Predicate.isTagged(claimed, "Claimed")) {
      return yield* Effect.die("consumer A did not get the claim");
    }

    const stale = claimed.row;

    if (!Predicate.isTagged(stale.message, "IssueCode")) {
      return yield* Effect.die("the row is not a code message");
    }

    yield* sql`update outbox set claimed_until = now() - interval '1 minute' where id = ${Number(id)}`;

    return { id, message: stale.message, stale };
  });

/**
 * Spec 0024 R9. Consumer A claims the row of an invitation, its lease lapses, and consumer B delivers the row completely
 * (a mail, a usable code, a delivered row). Then A runs its `issueCode` on the claim that it still holds, with the send
 * working or down (`sendFails`). What it leaves behind is what the test reads.
 */
const staleConsumer = (
  personId: number,
  options: { readonly fenced: boolean; readonly sendFails: boolean }
) =>
  Effect.gen(function* staleRun() {
    const { id, message, stale } = yield* lapsedClaimOf(personId);
    assert.strictEqual(yield* deliveryTag(id), "Delivered");
    const deliveredToken = yield* tokenAt(0);

    if (options.sendFails) {
      hooks.before = () => Effect.die("the provider is down");
    }

    const delivery = options.fenced
      ? yield* AccountDelivery
      : yield* unfencedDelivery;

    const exit = yield* Effect.exit(delivery.issueCode(stale, message));

    return {
      answer: Exit.isSuccess(exit) ? exit.value : "the send died",
      deliveredCodeWorks: yield* authenticates(deliveredToken, "activation"),
      mails: hooks.sent.length,
      row: (yield* rowStatus(id)).status,
      states: yield* codeStates(personId),
    };
  });

/**
 * Spec 0024, revision R4. The same stale consumer A, but consumer B has only claimed the lapsed row and
 * has delivered nothing: the row is `pending` with B's token. Only the token check refuses A here (the `status` check
 * alone does not: the row is pending), so removing the token from `holdClaim` fails the fenced test below.
 */
const claimedByAnother = (
  personId: number,
  options: { readonly fenced: boolean }
) =>
  Effect.gen(function* claimedRun() {
    const { id, message, stale } = yield* lapsedClaimOf(personId);
    const claimedByB = yield* (yield* OutboxDelivery).claim(id, 120);

    if (!Predicate.isTagged(claimedByB, "Claimed")) {
      return yield* Effect.die("consumer B did not get the claim");
    }

    const delivery = options.fenced
      ? yield* AccountDelivery
      : yield* unfencedDelivery;

    const answer = yield* delivery.issueCode(stale, message);

    return {
      answer,
      bStillHoldsIt: (yield* rowStatus(id)).status === "pending",
      mails: hooks.sent.length,
      states: yield* codeStates(personId),
    };
  });

layer(liveWith(controlled), { excludeTestServices: true })(
  "spec 0024: code delivery outside the transaction",
  (it) => {
    it.effect(
      "F1: the code is committed unsent before the mail leaves, its link is refused while the mail is on its way, and it works after the second transaction",
      () =>
        Effect.gen(function* journey() {
          yield* reset;
          const id = yield* invite(711);
          const provide = yield* withStore;

          const seen: {
            readonly authenticates: boolean;
            readonly states: readonly string[];
          }[] = [];

          const observe = (sent: Sent) =>
            provide(
              Effect.gen(function* observeStore() {
                seen.push({
                  authenticates: yield* authenticates(sent.token, "activation"),
                  states: yield* codeStates(711),
                });
              })
            );

          hooks.before = observe;
          hooks.after = observe;

          assert.strictEqual(yield* deliveryTag(id), "Delivered");

          // Before the send the first transaction had committed (this connection reads it) and the code was unusable;
          // after the send, and before the second transaction, the same. The person's link has not worked yet.
          assert.deepStrictEqual(seen, [
            { authenticates: false, states: ["Unsent"] },
            { authenticates: false, states: ["Unsent"] },
          ]);

          assert.deepStrictEqual(yield* codeStates(711), ["Usable"]);
          assert.lengthOf(hooks.sent, 1);
          assert.isTrue(yield* authenticates(yield* tokenAt(0), "activation"));
          assert.strictEqual((yield* rowStatus(id)).status, "delivered");
        })
    );

    it.effect(
      "F2: a crash between the send and the acknowledgement (a defect, then an interruption) leaves each mailed code unusable, and the redelivery's code is the only one that works",
      () =>
        Effect.gen(function* crashes() {
          yield* reset;
          const row = yield* invite(721);

          // The delivery dies after the provider answered.
          hooks.after = () => Effect.die("the process died after the send");
          assert.strictEqual(yield* deliveryTag(row), "Retrying");
          assert.strictEqual((yield* rowStatus(row)).status, "pending");
          assert.strictEqual(
            (yield* rowStatus(row)).lastError,
            "delivery defect"
          );
          assert.deepStrictEqual(yield* codeStates(721), ["Unsent"]);

          // The redelivery is interrupted after its send: no handler sees it, the claim stays held.
          hooks.after = () => Effect.interrupt;
          const interrupted = yield* Effect.exit(deliverOutbox([row]));

          assert.isTrue(
            Exit.isFailure(interrupted) &&
              Cause.hasInterrupts(interrupted.cause)
          );
          assert.deepStrictEqual(yield* codeStates(721), ["Unsent"]);
          assert.lengthOf(hooks.sent, 2);

          // While its lease holds, another consumer is told to look again later and sends nothing.
          hooks.after = quiet;
          assert.strictEqual(yield* deliveryTag(row), "Held");
          assert.lengthOf(hooks.sent, 2);

          // The lease runs out: the next delivery mints a third code, mails it and acknowledges it.
          yield* leaseRanOut(row);
          assert.strictEqual(yield* deliveryTag(row), "Delivered");
          assert.lengthOf(hooks.sent, 3);
          assert.deepStrictEqual(yield* codeStates(721), ["Usable"]);

          const results = yield* Effect.forEach(hooks.sent, (sent) =>
            authenticates(sent.token, "activation")
          );

          assert.deepStrictEqual(results, [false, false, true]);
        })
    );

    it.effect(
      "F3: an account that changes between the two transactions: the acknowledged code is refused at use",
      () =>
        Effect.gen(function* accountChanges() {
          yield* reset;
          const sql = yield* SqlClient;
          const row = yield* invite(731);

          hooks.after = () =>
            sql`update account set state = 'Deactivated' where person_id = 731`.pipe(
              Effect.orDie,
              Effect.asVoid
            );

          assert.strictEqual(yield* deliveryTag(row), "Delivered");
          assert.deepStrictEqual(yield* codeStates(731), ["Usable"]);
          assert.isFalse(yield* authenticates(yield* tokenAt(0), "activation"));
        })
    );

    it.effect(
      "F4: an older attempt's acknowledgement never makes the newer attempt's unsent code usable, and its own mail is dead",
      () =>
        Effect.gen(function* olderAcknowledges() {
          yield* reset;
          const { newer, older } = yield* askForResetTwice(741);

          const olderSending = yield* Deferred.make<null>();
          const olderMayAck = yield* Deferred.make<null>();
          const newerSending = yield* Deferred.make<null>();
          const newerMayAck = yield* Deferred.make<null>();

          hooks.after = (sent) =>
            sent.key.startsWith(`${older}.`)
              ? Deferred.succeed(olderSending, null).pipe(
                  Effect.andThen(Deferred.await(olderMayAck))
                )
              : Deferred.succeed(newerSending, null).pipe(
                  Effect.andThen(Deferred.await(newerMayAck))
                );

          const olderRun = yield* Effect.forkChild(deliverOutbox([older]));
          yield* Deferred.await(olderSending);

          // The newer attempt stores its code (replacing the older one) and sends; both mails are out, neither has
          // been acknowledged.
          const newerRun = yield* Effect.forkChild(deliverOutbox([newer]));
          yield* Deferred.await(newerSending);
          assert.deepStrictEqual(yield* codeStates(741), ["Unsent"]);

          // The older attempt's second transaction runs now: its code is gone, so it acknowledges nothing.
          yield* Deferred.succeed(olderMayAck, null);
          yield* Fiber.join(olderRun);

          assert.deepStrictEqual(yield* codeStates(741), ["Unsent"]);
          assert.isFalse(
            yield* authenticates(yield* tokenAt(1), "resetPassword"),
            "the newer mail is not usable before its own acknowledgement"
          );

          yield* Deferred.succeed(newerMayAck, null);
          yield* Fiber.join(newerRun);

          assert.deepStrictEqual(yield* codeStates(741), ["Usable"]);
          assert.isFalse(
            yield* authenticates(yield* tokenAt(0), "resetPassword")
          );
          assert.isTrue(
            yield* authenticates(yield* tokenAt(1), "resetPassword")
          );
          assert.strictEqual((yield* rowStatus(older)).status, "delivered");
          assert.strictEqual((yield* rowStatus(newer)).status, "delivered");
        })
    );

    it.effect(
      `F4 (a guard, not a lock falsifier): two concurrent attempts for one person end with one code, usable, and exactly one working mail, in each of ${ROUNDS} fresh rounds`,
      () =>
        Effect.gen(function* concurrentAttempts() {
          const problems = yield* Effect.forEach(
            Arr.range(1, ROUNDS),
            concurrentRound
          );

          assert.deepStrictEqual(Arr.flatten(problems), []);
        }),
      { timeout: 120_000 }
    );

    it.effect(
      "F7: the delivery's sender and every member of Better Auth, called inside Transactor.run on PostgreSQL, die as the guard's defect and leave no mail",
      () =>
        Effect.gen(function* portsRefuse() {
          yield* reset;
          const sql = yield* SqlClient;
          const sender = yield* MessageSender;
          const auth = yield* Auth;

          const mail = OutboxMessage.cases.Email.make({
            replyTo: null,
            subject: "Kode",
            text: "Hei c_0000000000000000000000000000000000000000000",
            to: EmailAddress.make("kari@example.org"),
          });

          const personId = PersonId.make(1);

          // Each member is asked for inside the transaction with arguments that a real call would take: the guard
          // refuses before it reads them. `Auth` has four members, and a Layer that wrapped fewer is found by name.
          const members: readonly (readonly [
            string,
            Effect.Effect<unknown, unknown>,
          ])[] = [
            ["MessageSender.send", sender.send(mail, "inside")],
            ["Auth.handle", auth.handle(new Request("https://mail.example/"))],
            ["Auth.session", auth.session(new Headers())],
            [
              "Auth.setCredential",
              auth.setCredential({
                at: DateTime.makeUnsafe("2026-10-29T12:00:00Z"),
                passwordHash: PasswordHash.make(`$2b$12$${"a".repeat(53)}`),
                personId,
                revokeSessions: false,
                version: 1,
              }),
            ],
            [
              "Auth.signInPerson",
              auth.signInPerson({
                headers: new Headers(),
                password: "a password",
                personId,
              }),
            ],
          ];

          const refused = yield* Effect.forEach(members, ([, member]) =>
            Effect.map(Effect.exit(transacted(member)), refusedCall)
          );

          assert.deepStrictEqual(
            refused,
            Arr.map(members, ([name]) => name)
          );

          const [mailbox] = yield* sql<{
            readonly n: number;
          }>`select count(*)::int as n from captured_mail where delivery_key = 'inside'`;

          assert.strictEqual(mailbox?.n, 0);
          assert.lengthOf(hooks.sent, 0);
        })
    );

    it.effect(
      "F11: a consumer whose lease lapsed while another delivered the row writes nothing and mails nothing, with the send working or down, and the delivered code stays usable",
      () =>
        Effect.gen(function* fencedConsumer() {
          const working = yield* staleConsumer(761, {
            fenced: true,
            sendFails: false,
          });

          const down = yield* staleConsumer(762, {
            fenced: true,
            sendFails: true,
          });

          for (const seen of [working, down]) {
            assert.deepStrictEqual(seen, {
              answer: "claimLost",
              deliveredCodeWorks: true,
              mails: 1,
              row: "delivered",
              states: ["Usable"],
            });
          }
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F11 control: the same consumer without the fence replaces the delivered code: a second mail when the send works, and no working link at all, on a delivered row, when it is down",
      () =>
        Effect.gen(function* unfencedConsumer() {
          const working = yield* staleConsumer(771, {
            fenced: false,
            sendFails: false,
          });

          const down = yield* staleConsumer(772, {
            fenced: false,
            sendFails: true,
          });

          // Send working: a needless second mail kills the first one's link; the newer code is acknowledged (D5).
          assert.deepStrictEqual(working, {
            answer: "claimLost",
            deliveredCodeWorks: false,
            mails: 2,
            row: "delivered",
            states: ["Usable"],
          });

          // Send down: the reviewer's case. The delivered code is gone, the replacement was never mailed.
          assert.deepStrictEqual(down, {
            answer: "the send died",
            deliveredCodeWorks: false,
            mails: 1,
            row: "delivered",
            states: ["Unsent"],
          });
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F12 (D5): a claim lost between the send and the acknowledgement: the acknowledgement still commits for the code that was mailed, and the row stays with the consumer that took it",
      () =>
        Effect.gen(function* lostBeforeAcknowledgement() {
          yield* reset;
          const id = yield* invite(781);
          const provide = yield* withStore;

          // The lease lapses after the send and another consumer claims the row, and does nothing more.
          hooks.after = () =>
            provide(
              Effect.gen(function* stealClaim() {
                const sql = yield* SqlClient;
                yield* sql`update outbox set claimed_until = now() - interval '1 minute' where id = ${Number(id)}`;
                yield* (yield* OutboxDelivery).claim(id, 120);
              }).pipe(Effect.orDie)
            );

          assert.strictEqual(yield* deliveryTag(id), "Settled");
          assert.deepStrictEqual(yield* codeStates(781), ["Usable"]);
          assert.isTrue(yield* authenticates(yield* tokenAt(0), "activation"));
          assert.strictEqual((yield* rowStatus(id)).status, "pending");
        })
    );

    it.effect(
      "F11 (token): a consumer whose lease lapsed while another has claimed the row and not delivered it writes nothing and mails nothing, and the other consumer keeps the row",
      () =>
        Effect.gen(function* fencedByToken() {
          assert.deepStrictEqual(
            yield* claimedByAnother(791, { fenced: true }),
            {
              answer: "claimLost",
              bStillHoldsIt: true,
              mails: 0,
              states: [],
            }
          );
        }),
      { timeout: 60_000 }
    );

    it.effect(
      "F11 (token) control: without the fence the same consumer stores, mails and acknowledges a code while another consumer holds the row, so B's delivery would replace it with a second mail",
      () =>
        Effect.gen(function* unfencedByToken() {
          assert.deepStrictEqual(
            yield* claimedByAnother(792, { fenced: false }),
            {
              answer: "claimLost",
              bStillHoldsIt: true,
              mails: 1,
              states: ["Usable"],
            }
          );
        }),
      { timeout: 60_000 }
    );
  }
);
