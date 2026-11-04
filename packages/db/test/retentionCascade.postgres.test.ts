/** Provider cleanup is an outbox intent, never a cross-system write inside retention. */
import { assert, layer } from "@effect/vitest";
import {
  DeleteAuthUserMessage,
  PersonId,
  RelinkAuthUserMessage,
  PersonalDataDeclaration,
  afterDuration,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { personalDataRetentionReport } from "../src/personalData/retention.ts";
import { Drizzle, postgresJobDatabase } from "./support/database.ts";
import { encodeJson } from "./support/json.ts";
import { nightlyOutcome } from "./support/retentionRun.ts";
import { snapshot } from "./support/snapshot.ts";
import { providerSnapshot, providerUserId } from "./support/supabaseAuth.ts";
import { world } from "./support/teamsWorld.ts";

const start = DateTime.makeUnsafe("2020-01-01T00:00:00Z");
const now = afterDuration(start, PersonalDataDeclaration.years(3));
const later = afterDuration(now, PersonalDataDeclaration.years(1));

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0007b R4: retention respects the Supabase ownership boundary",
  (it) => {
    it.effect(
      "RULE-201: expired person queues exactly one provider deletion; expired, current and unlimited sessions remain provider-owned",
      () =>
        Effect.gen(function* cascade() {
          const sql = yield* SqlClient;
          const db = yield* Drizzle;
          const old = yield* world("cascade-old");
          const current = yield* world("cascade-current");
          yield* sql`update person set created_at = ${DateTime.toDateUtc(start)} where id = ${old.person.id}`;
          yield* sql`update person set created_at = ${DateTime.toDateUtc(now)} where id = ${current.person.id}`;

          for (const person of [old.person, current.person]) {
            const userId = providerUserId(person.id);
            yield* sql`insert into auth.users (id, email, raw_app_meta_data, created_at, updated_at)
            values (${userId}, ${person.email}, ${yield* encodeJson({ personId: person.id })}::jsonb, ${DateTime.toDateUtc(start)}, ${DateTime.toDateUtc(start)})`;
            yield* sql`insert into auth.identities (id, user_id, provider) values (${userId}, ${userId}, 'email')`;

            for (const [index, expiry] of [start, later, null].entries()) {
              const sessionId = `00000000-0000-4000-9000-${(person.id * 10 + index).toString(16).padStart(12, "0")}`;
              yield* sql`insert into auth.sessions (id, user_id, created_at, not_after)
              values (${sessionId}, ${userId}, ${DateTime.toDateUtc(start)}, ${expiry === null ? null : DateTime.toDateUtc(expiry)})`;
            }
          }

          const before = yield* snapshot;
          const providerBefore = yield* providerSnapshot;

          const reported = yield* transactional(
            personalDataRetentionReport(db).expire(now)
          );

          assert.deepStrictEqual(yield* snapshot, before);
          assert.deepStrictEqual(yield* providerSnapshot, providerBefore);
          assert.strictEqual(reported.person, 1);
          const applied = yield* transactional(nightlyOutcome(now));
          assert.strictEqual(applied.counts.person, 1);
          assert.deepStrictEqual(yield* providerSnapshot, providerBefore);

          const intents =
            yield* sql`select payload from outbox where kind = 'DeleteAuthUser' order by id`;

          assert.deepStrictEqual(intents, [
            {
              payload: {
                _tag: "DeleteAuthUser",
                userId: providerUserId(old.person.id),
              },
            },
          ]);
          yield* transactional(nightlyOutcome(now));
          assert.deepStrictEqual(
            yield* sql`select payload from outbox where kind = 'DeleteAuthUser' order by id`,
            intents
          );
        })
    );
    it.effect(
      "RULE-201: overdue pending provider deletion and relink intents survive retention; delivered intents expire",
      () =>
        Effect.gen(function* pendingIntents() {
          const sql = yield* SqlClient;
          const userId = "00000000-0000-4000-8000-ffffffffffff";

          const cases = Arr.flatMap(
            [
              DeleteAuthUserMessage.make({ userId }),
              RelinkAuthUserMessage.make({
                from: PersonId.make(123),
                into: PersonId.make(456),
                userId,
              }),
            ],
            (payload) => [
              { deliveredAt: null, payload, status: "pending" },
              {
                deliveredAt: DateTime.toDateUtc(start),
                payload,
                status: "delivered",
              },
            ]
          );

          for (const { deliveredAt, payload, status } of cases) {
            yield* sql`insert into outbox (kind, payload, status, created_at, next_attempt_at, delivered_at)
              values (${payload._tag}, ${yield* encodeJson(payload)}::jsonb, ${status}, ${DateTime.toDateUtc(start)}, ${DateTime.toDateUtc(start)}, ${deliveredAt})`;
          }

          yield* transactional(
            nightlyOutcome(DateTime.makeUnsafe("2026-10-27T12:00:00Z"))
          );
          assert.deepStrictEqual(
            yield* sql`select kind, delivered_at is not null as delivered from outbox where payload->>'userId' = ${userId} order by kind`,
            [
              { delivered: false, kind: "DeleteAuthUser" },
              { delivered: false, kind: "RelinkAuthUser" },
            ]
          );
        })
    );
  }
);
