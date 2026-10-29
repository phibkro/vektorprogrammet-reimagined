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
 *     inside `Transactor.run` on PostgreSQL, die and leave no mail.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  CapturedMessageStore,
  CodeToken,
  CurrentPrincipal,
  DepartmentId,
  EmailAddress,
  IntegrationCalledInTransaction,
  OutboxMessage,
  OutboxMessageId,
  PersonId,
  Principal,
  TeamId,
  anonymous,
  codePrincipal,
  refusingInTransaction,
} from "@vektorprogrammet/domain";
import type {
  AccountRepository,
  CodePurpose,
  CodeRepository,
  TransportMessage,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { Crypto } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Auth } from "../src/server/auth";
import { deliverOutbox } from "../src/server/outboxDelivery";
import { MessageSender } from "../src/server/senders";
import { liveWith } from "./support/deliveryLive";
import { transacted } from "./support/transacted";

interface Sent {
  readonly key: string;
  readonly token: CodeToken;
}

/** The services that a hook reads the store with: they are the delivery stack's, provided to the test and to the sender alike. */
type StoreServices =
  | AccountRepository
  | CodeRepository
  | Crypto.Crypto
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

const leader = Principal.cases.Person.make({
  memberships: [
    {
      departmentId: DepartmentId.make(DEPARTMENT),
      function: "recruitment",
      leader: true,
      teamId: TeamId.make(DEPARTMENT),
    },
  ],
  personId: PersonId.make(LEADER),
});

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
      `F4: two concurrent attempts for one person: exactly one of the two mails works, in each of ${ROUNDS} fresh rounds`,
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
      "F7: the delivery's sender and Better Auth, called inside Transactor.run on PostgreSQL, die and leave no mail",
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

          const sending = yield* Effect.exit(
            transacted(sender.send(mail, "inside"))
          );

          const reading = yield* Effect.exit(
            transacted(auth.session(new Headers()))
          );

          assert.strictEqual(refusedCall(sending), "MessageSender.send");
          assert.strictEqual(refusedCall(reading), "Auth.session");

          const [mailbox] = yield* sql<{
            readonly n: number;
          }>`select count(*)::int as n from captured_mail where delivery_key = 'inside'`;

          assert.strictEqual(mailbox?.n, 0);
          assert.lengthOf(hooks.sent, 0);
        })
    );
  }
);
