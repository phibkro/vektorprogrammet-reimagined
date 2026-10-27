/** A report must count sessions deleted by an expired user's cascade as well as sessions past their own expiry. */
import { assert, layer } from "@effect/vitest";
import {
  PersonalDataDeclaration,
  afterDuration,
} from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { personalDataRetentionReport } from "../src/personalData/retention.ts";
import { Drizzle, postgresJobDatabase } from "./support/database.ts";
import { nightlyOutcome } from "./support/retentionRun.ts";
import { snapshot } from "./support/snapshot.ts";
import { world } from "./support/teamsWorld.ts";

const start = DateTime.makeUnsafe("2020-01-01T00:00:00Z");
const now = afterDuration(start, PersonalDataDeclaration.years(3));
const later = afterDuration(now, PersonalDataDeclaration.years(1));

const session = (id: string, user: string, expiry: DateTime.Utc) => ({
  created_at: DateTime.toDateUtc(start),
  expires_at: DateTime.toDateUtc(expiry),
  id,
  token: id,
  updated_at: DateTime.toDateUtc(start),
  user_id: user,
});

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0007b R4: a report counts cascaded sessions",
  (it) => {
    it.effect(
      "count expired and unexpired sessions of an expired user and only the expired session of a current user",
      () =>
        Effect.gen(function* cascade() {
          const sql = yield* SqlClient;
          const db = yield* Drizzle;
          const old = yield* world("cascade-old");
          const current = yield* world("cascade-current");
          yield* sql`update person set created_at = ${DateTime.toDateUtc(start)} where id = ${old.person.id}`;
          yield* sql`update person set created_at = ${DateTime.toDateUtc(now)} where id = ${current.person.id}`;
          yield* sql`insert into auth_user ${sql.insert([
            {
              created_at: DateTime.toDateUtc(start),
              email: "old-auth@example.org",
              id: "old-user",
              name: "Old",
              person_id: old.person.id,
              updated_at: DateTime.toDateUtc(start),
            },
            {
              created_at: DateTime.toDateUtc(start),
              email: "current-auth@example.org",
              id: "current-user",
              name: "Current",
              person_id: current.person.id,
              updated_at: DateTime.toDateUtc(start),
            },
          ])}`;
          yield* sql`insert into auth_session ${sql.insert([
            session("old-expired", "old-user", start),
            session("old-current", "old-user", later),
            session("current-expired", "current-user", start),
            session("current-current", "current-user", later),
          ])}`;

          const before = yield* snapshot;

          const reported = yield* transactional(
            personalDataRetentionReport(db).expire(now)
          );

          assert.deepStrictEqual(yield* snapshot, before);
          const applied = yield* transactional(nightlyOutcome(now));

          const remaining = yield* sql<{
            readonly id: string;
          }>`select id from auth_session`;

          assert.deepStrictEqual(remaining, [{ id: "current-current" }]);
          assert.strictEqual(reported.auth_user, 1);
          assert.strictEqual(reported.auth_session, 3);
          assert.strictEqual(applied.counts.auth_session, 3);
        })
    );
  }
);
