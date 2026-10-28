/** Spec 0007 R1/falsifier 4: scan every database text/json column except the fake mailbox. */
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  CodeToken,
  CurrentPrincipal,
  DepartmentId,
  OutboxMessageId,
  PersonId,
  Principal,
  TeamId,
  authorize,
  codePrincipal,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Effect,
  Exit,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { deliverOutbox } from "../src/server/outboxDelivery";
import { deliverPending, live } from "./support/deliveryLive";
import { transacted } from "./support/transacted";

const columns = Schema.Array(
  Schema.Struct({
    column_name: Schema.String,
    table_name: Schema.String,
    table_schema: Schema.String,
  })
);

const values = Schema.Array(
  Schema.Struct({ value: Schema.NullOr(Schema.String) })
);

const mail = Schema.Struct({ text: Schema.String });

const quote = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

/** Only public.captured_mail retains a link. Scan every non-system schema, including Drizzle's. */
const snapshot = Effect.gen(function* snapshot() {
  const sql = yield* SqlClient;

  const fields = yield* Schema.decodeUnknownEffect(columns)(
    yield* sql`select c.table_schema, c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name where c.table_schema !~ '^pg_' and c.table_schema <> 'information_schema' and t.table_type = 'BASE TABLE' and c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb') and (c.table_schema, c.table_name) <> ('public', 'captured_mail') order by c.table_schema, c.table_name, c.ordinal_position`
  );

  return yield* Effect.forEach(fields, (field) =>
    Effect.gen(function* readColumn() {
      const rows = yield* sql.unsafe(
        `select ${quote(field.column_name)}::text as value from ${quote(field.table_schema)}.${quote(field.table_name)}`
      );

      const decoded = yield* Schema.decodeUnknownEffect(values)(rows);

      return {
        field: `${field.table_schema}.${field.table_name}.${field.column_name}`,
        values: Arr.flatMap(decoded, (row) =>
          row.value === null ? [] : [row.value]
        ),
      };
    })
  );
}).pipe(Effect.orDie);

const leaked = (
  data: readonly {
    readonly field: string;
    readonly values: readonly string[];
  }[],
  token: string
) =>
  Arr.filter(data, (column) =>
    Arr.some(column.values, (value) => value.includes(token))
  );

const latestToken = Effect.gen(function* latestToken() {
  const sql = yield* SqlClient;

  const rows =
    yield* sql`select text from captured_mail order by id desc limit 1`;

  const row = yield* Schema.decodeUnknownEffect(mail)(rows[0]);
  const found = /[?&]kode=(?<token>c_[A-Za-z0-9_-]{43})/u.exec(row.text);
  assert.isNotNull(found, "captured email contains a code link");

  return CodeToken.make(found?.groups?.token ?? "");
}).pipe(Effect.orDie);

/**
 * Makes a delivered message pending again, as a redelivery after a crash would find it. The claim asks only for a pending
 * row with no live claim (spec 0008b), never whether it is due, so there is no clock to compare and nothing to skip a
 * row by a fraction of a millisecond (the cause of issue #21).
 */
const requeue = Effect.fnUntraced(function* requeue(id: OutboxMessageId) {
  const sql = yield* SqlClient;
  yield* sql`update outbox set status = 'pending', delivered_at = null where id = ${Number(id)}`;
});

const ROUNDS = 1000;
const LEADER = 301;

const leaderPrincipal = Principal.cases.Person.make({
  memberships: [
    {
      departmentId: DepartmentId.make(LEADER),
      function: "recruitment",
      leader: true,
      teamId: TeamId.make(LEADER),
    },
  ],
  personId: PersonId.make(LEADER),
});

const idRows = Schema.Array(Schema.Struct({ id: Schema.Finite }));

/** Fresh state per round: a new Invited person and the one IssueCode message that invitation committed. */
const invite = (personId: number) =>
  Effect.gen(function* invitePerson() {
    const sql = yield* SqlClient;
    const email = `invitee${personId}@example.org`;
    yield* sql`insert into person (id, name, email, field_of_study_id) values (${personId}, 'Invitee', ${email}, ${LEADER})`;
    yield* transacted(
      AccountEndpoints.createAccount({ personId }).pipe(
        Effect.provideService(CurrentPrincipal, leaderPrincipal)
      )
    );

    const [row] = yield* Schema.decodeUnknownEffect(idRows)(
      yield* sql`select id from outbox where kind = 'IssueCode' and payload->>'personId' = ${String(personId)}`
    );

    return OutboxMessageId.make(String(row?.id));
  }).pipe(Effect.orDie);

/** Both retry tests share one leader; whichever runs first seeds it. */
const seedLeader = Effect.gen(function* seedLeader() {
  const sql = yield* SqlClient;
  yield* sql`insert into department (id, city, email, name, short_name) values (${LEADER}, 'Retryby', 'retry@example.org', 'Retry', 'RET') on conflict do nothing`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (${LEADER}, ${LEADER}, 'Retry', 'RET') on conflict do nothing`;
  yield* sql`insert into person (id, name, email, field_of_study_id) values (${LEADER}, 'Leader', 'retryleader@example.org', ${LEADER}) on conflict do nothing`;
}).pipe(Effect.orDie);

/** One invite, delivery, requeue and retried delivery; both deliveries must record. */
const retriedRound = (personId: number) =>
  Effect.gen(function* deliverTwice() {
    const id = yield* invite(personId);
    const [first] = yield* deliverOutbox([id]);
    assert.strictEqual(first?._tag, "Delivered");
    yield* requeue(id);
    const [retry] = yield* deliverOutbox([id]);
    assert.strictEqual(retry?._tag, "Delivered");
  });

layer(live, { excludeTestServices: true })(
  "spec 0007: redacted outbox delivery",
  (it) => {
    it.effect(
      "invite, delivery and retried delivery leave plaintext only in the capture mailbox",
      () =>
        Effect.gen(function* codeDeliveryScan() {
          const sql = yield* SqlClient;
          // A same-named table in another application schema is not the capture sink.
          yield* sql`create schema scan_fixture`;
          yield* sql`create table scan_fixture.captured_mail (content text)`;
          yield* sql`insert into department (id, city, email, name, short_name) values (201, 'Mailby', 'mail@example.org', 'Mail', 'MAI')`;
          yield* sql`insert into field_of_study (id, department_id, name, short_name) values (201, 201, 'Mail', 'MAI')`;
          yield* sql`insert into person (id, name, email, field_of_study_id) values (201, 'Leader', 'leader@example.org', 201), (202, 'Invitee', 'invitee@example.org', 201)`;
          yield* sql`insert into admin_grant (person_id, until) values (202, '2099-01-01T00:00:00Z')`;

          const leader = Principal.cases.Person.make({
            memberships: [
              {
                departmentId: DepartmentId.make(201),
                function: "recruitment",
                leader: true,
                teamId: TeamId.make(201),
              },
            ],
            personId: PersonId.make(201),
          });

          yield* transacted(
            AccountEndpoints.createAccount({ personId: 202 }).pipe(
              Effect.provideService(CurrentPrincipal, leader)
            )
          );
          const afterCommand = yield* snapshot;
          const [first] = yield* deliverPending;
          assert.strictEqual(first?._tag, "Delivered");
          const token1 = yield* latestToken;
          assert.isTrue(
            Option.isSome(yield* codePrincipal(token1, "activation"))
          );
          assert.deepStrictEqual(leaked(afterCommand, token1), []);
          assert.deepStrictEqual(leaked(yield* snapshot, token1), []);

          // Simulate the same message being retried after a crash; a new code replaces the old one.
          assert.isDefined(first);
          yield* requeue(first.id);
          const [retry] = yield* deliverPending;
          assert.strictEqual(retry?._tag, "Delivered");
          const token2 = yield* latestToken;
          assert.notStrictEqual(token1, token2);
          assert.isTrue(
            Option.isNone(yield* codePrincipal(token1, "activation"))
          );
          const codeHolder = yield* codePrincipal(token2, "activation");
          assert.isTrue(Option.isSome(codeHolder));

          if (Option.isSome(codeHolder)) {
            assert.isTrue(
              authorize(codeHolder.value, "activateAccount", {
                personId: PersonId.make(202),
              })
            );
            assert.isFalse(
              authorize(codeHolder.value, "deactivateAccount", {
                personId: PersonId.make(201),
              })
            );
          }

          const afterRetry = yield* snapshot;
          assert.deepStrictEqual(leaked(afterRetry, token1), []);
          assert.deepStrictEqual(leaked(afterRetry, token2), []);

          const activated = yield* transacted(
            AccountEndpoints.activateAccount({
              code: token2,
              password: "safe test password",
            })
          );

          assert.isTrue(Predicate.isTagged(activated.state, "Active"));
          assert.deepStrictEqual(leaked(yield* snapshot, token2), []);

          // Negative control: writing the plaintext into the outbox payload is observable by this same scan.
          yield* sql`update outbox set payload = jsonb_set(payload, '{leak}', to_jsonb(${token2}::text)) where kind = 'IssueCode'`;
          assert.isTrue(
            Arr.some(
              leaked(yield* snapshot, token2),
              (column) => column.field === "public.outbox.payload"
            )
          );
          // A leak outside public, even in a table named captured_mail, is also detected.
          yield* sql`insert into scan_fixture.captured_mail (content) values (${token2})`;
          assert.isTrue(
            Arr.some(
              leaked(yield* snapshot, token2),
              (column) => column.field === "scan_fixture.captured_mail.content"
            )
          );
        })
    );

    // Spec 0007 R14. The old reset (`next_attempt_at = now()`) lost about 1 round in 100 to 1 in 250; with
    // that reset this test failed in 7 of 8 runs of these rounds. The next test pins the cause exactly.
    it.effect(
      `a requeued code message is delivered again in each of ${ROUNDS} fresh rounds`,
      () =>
        Effect.gen(function* retryRounds() {
          yield* seedLeader;

          const exits = yield* Effect.forEach(
            Arr.range(0, ROUNDS - 1),
            (round) => Effect.exit(retriedRound(1000 + round))
          );

          const losers = Arr.flatMap(exits, (exit, round) =>
            Exit.isFailure(exit)
              ? [`round ${round}: ${Cause.pretty(exit.cause)}`]
              : []
          );

          assert.deepStrictEqual(losers, []);
        }),
      { timeout: 120_000 }
    );
  }
);
