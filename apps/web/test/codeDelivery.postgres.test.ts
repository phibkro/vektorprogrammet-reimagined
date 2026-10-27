/** Spec 0007 R1/falsifier 4: scan every database text/json column except the fake mailbox. */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive, transactional } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  AccountEndpoints,
  CodeToken,
  CurrentPrincipal,
  DepartmentId,
  PersonId,
  Principal,
  SiteOrigin,
  TeamId,
  authorize,
  codePrincipal,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { accountDeliveryLayer } from "../src/server/accountDelivery";
import { authLayer } from "../src/server/auth";
import { deliverOutbox } from "../src/server/outboxDelivery";
import { passwordHasherLayer } from "../src/server/password";
import { captureSenderLayer } from "../src/server/senders";
import { webCryptoLayer } from "../src/server/webCrypto";

const origin = "https://mail.example";

const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) => {
    const infrastructure = Layer.mergeAll(
      DatabaseLive({ maxConnections: 8, url }),
      authLayer({
        BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
        HYPERDRIVE: { connectionString: Redacted.value(url) },
        SITE_URL: origin,
      }),
      passwordHasherLayer,
      webCryptoLayer,
      Layer.succeed(SiteOrigin)(origin)
    );

    const capture = captureSenderLayer.pipe(Layer.provideMerge(infrastructure));

    return accountDeliveryLayer.pipe(Layer.provideMerge(capture));
  })
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

const columns = Schema.Array(
  Schema.Struct({ column_name: Schema.String, table_name: Schema.String })
);

const values = Schema.Array(
  Schema.Struct({ value: Schema.NullOr(Schema.String) })
);

const mail = Schema.Struct({ text: Schema.String });

const quote = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

/** The capture mailbox alone must retain the delivered link; every other table is scanned. */
const snapshot = Effect.gen(function* snapshot() {
  const sql = yield* SqlClient;

  const fields = yield* Schema.decodeUnknownEffect(columns)(
    yield* sql`select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb') and c.table_name <> 'captured_mail' order by c.table_name, c.ordinal_position`
  );

  return yield* Effect.forEach(fields, (field) =>
    Effect.gen(function* readColumn() {
      const rows = yield* sql.unsafe(
        `select ${quote(field.column_name)}::text as value from public.${quote(field.table_name)}`
      );

      const decoded = yield* Schema.decodeUnknownEffect(values)(rows);

      return {
        field: `${field.table_name}.${field.column_name}`,
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

layer(live, { excludeTestServices: true })(
  "spec 0007: redacted outbox delivery",
  (it) => {
    it.effect(
      "invite, delivery and retried delivery leave plaintext only in the capture mailbox",
      () =>
        Effect.gen(function* codeDeliveryScan() {
          const sql = yield* SqlClient;
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

          yield* transactional(
            AccountEndpoints.invite({ personId: 202 }).pipe(
              Effect.provideService(CurrentPrincipal, leader)
            )
          );
          const afterCommand = yield* snapshot;
          const [first] = yield* deliverOutbox({ limit: 10 });
          assert.strictEqual(first?.outcome, "delivered");
          const token1 = yield* latestToken;
          assert.isTrue(
            Option.isSome(yield* codePrincipal(token1, "activation"))
          );
          assert.deepStrictEqual(leaked(afterCommand, token1), []);
          assert.deepStrictEqual(leaked(yield* snapshot, token1), []);

          // Simulate the same message being retried after a crash; a new code replaces the old one.
          yield* sql`update outbox set status = 'pending', delivered_at = null, next_attempt_at = now() where kind = 'IssueCode'`;
          const [retry] = yield* deliverOutbox({ limit: 10 });
          assert.strictEqual(retry?.outcome, "delivered");
          const token2 = yield* latestToken;
          assert.notStrictEqual(token1, token2);
          assert.isTrue(
            Option.isNone(yield* codePrincipal(token1, "activation"))
          );
          const codeHolder = yield* codePrincipal(token2, "activation");
          assert.isTrue(Option.isSome(codeHolder));

          if (Option.isSome(codeHolder)) {
            assert.isTrue(
              authorize(codeHolder.value, "activate", {
                personId: PersonId.make(202),
              })
            );
            assert.isFalse(
              authorize(codeHolder.value, "deactivate", {
                personId: PersonId.make(201),
              })
            );
          }

          const afterRetry = yield* snapshot;
          assert.deepStrictEqual(leaked(afterRetry, token1), []);
          assert.deepStrictEqual(leaked(afterRetry, token2), []);

          const activated = yield* transactional(
            AccountEndpoints.activate({
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
              (column) => column.field === "outbox.payload"
            )
          );
        })
    );
  }
);
