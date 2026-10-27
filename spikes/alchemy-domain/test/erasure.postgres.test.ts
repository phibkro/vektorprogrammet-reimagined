import * as Domain from "@alchemy.run/domain";
import { assert, it } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import {
  DepartmentId,
  MembershipId,
  PersonId,
  PositionId,
  Principal,
  TeamId,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { CommandFacts, RequestPrincipal } from "../src/model/context.ts";
import { PersonKey } from "../src/model/ids.ts";
import {
  CreateMembership,
  ErasePerson,
  MembershipAdded,
  Person,
  PersonErased,
  PersonStateSchema,
} from "../src/model/person.ts";
import {
  PersonProfileRows,
  PersonProfileRowsLive,
} from "../src/model/projections.ts";
import { layer as postgresPlatform } from "../src/postgresPlatform.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const CURRENT = { term: "HOST", year: 2026 } as const;
const NEXT_AUTUMN = { term: "HOST", year: 2027 } as const;
const ADMIN_UNTIL = DateTime.makeUnsafe("2099-12-31T23:59:59.999Z");

const database = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    postgresPlatform({
      now: Effect.succeed(DateTime.toEpochMillis(NOW)),
    }).pipe(Layer.provideMerge(DatabaseLive({ maxConnections: 10, url })))
  )
).pipe(Layer.provideMerge(migratedTestDatabase));

class ErasureModel extends Domain.Model("ErasureModel", {
  aggregates: [Person],
  projections: [PersonProfileRows],
}) {}

const erasureWorld = ErasureModel.layer(PersonProfileRowsLive).pipe(
  Layer.provideMerge(database)
);

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const scanPersonalValue = Effect.fnUntraced(function* scanPersonalValue(
  value: string
) {
  const sql = yield* SqlClient;

  const tableRows = yield* sql.unsafe(
    "select table_name as \"tableName\" from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
  );

  const tables = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ tableName: Schema.String }))
  )(tableRows).pipe(Effect.orDie);

  const hits = yield* Effect.forEach(
    tables,
    ({ tableName }) =>
      Effect.gen(function* scanTable() {
        const rows = yield* sql.unsafe(
          `select count(*)::int as hits from public.${quoteIdentifier(
            tableName
          )} as scanned where position($1 in to_jsonb(scanned)::text) > 0`,
          [value]
        );

        const [row] = rows;

        if (row === undefined) {
          return yield* Effect.die(
            `personal-value scan returned no row for ${tableName}`
          );
        }

        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ hits: Schema.Finite })
        )(row).pipe(Effect.orDie);

        return { hits: decoded.hits, tableName };
      }),
    { concurrency: 1 }
  );

  return Arr.filter(hits, (hit) => hit.hits > 0);
});

it.effect(
  "Person erasure deletes profile values transactionally while id-only history remains",
  () =>
    Effect.gen(function* erasePersonJourney() {
      const sql = yield* SqlClient;
      const people = yield* Person;
      const personId = PersonId.make(987_654_321);
      const membershipId = MembershipId.make(987_654_322);
      const departmentId = DepartmentId.make(111);
      const teamId = TeamId.make(333);

      const administrator = Principal.cases.Person.make({
        adminUntil: ADMIN_UNTIL,
        memberships: [],
        personId,
      });

      const membershipReceipt = yield* people
        .send(
          PersonKey.make(String(personId)),
          new CreateMembership({
            end: NEXT_AUTUMN,
            leader: false,
            membershipId,
            positionId: PositionId.make(222),
            start: CURRENT,
            teamId,
          }),
          { commandId: `seed-membership-${personId}` }
        )
        .pipe(
          Effect.provideService(RequestPrincipal, administrator),
          Effect.provideService(CommandFacts, {
            personDepartmentId: departmentId,
            resources: [{ departmentId }],
            team: { active: true, defaultTerm: 2, departmentId, id: teamId },
          })
        );

      assert.isTrue(
        Arr.some(membershipReceipt.events, (event) =>
          Schema.is(MembershipAdded)(event)
        )
      );

      const name = `Erasure test name ${personId}`;
      const email = `erase-${personId}@example.invalid`;
      const phone = `phone-erasure-${personId}`;
      const personalValues = [name, email, phone];

      yield* sql.unsafe(
        "insert into alchemy_person_profile (person_id, name, email, phone) values ($1, $2, $3, $4)",
        [personId, name, email, phone]
      );

      const before = yield* Effect.forEach(personalValues, scanPersonalValue, {
        concurrency: 1,
      });

      assert.strictEqual(before.length, personalValues.length);

      for (const hits of before) {
        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0]?.tableName, "alchemy_person_profile");
      }

      const receipt = yield* people.send(
        PersonKey.make(String(personId)),
        new ErasePerson({ personId }),
        { commandId: `erase-person-${personId}` }
      );

      const erasedEvents = Arr.filter(receipt.events, Schema.is(PersonErased));
      assert.strictEqual(erasedEvents.length, 1);
      assert.strictEqual(erasedEvents[0]?.personId, personId);

      const projectionRows = yield* sql.unsafe(
        "select distinct projection from alchemy_projection_key"
      );

      const projectionNames = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ projection: Schema.String }))
      )(projectionRows).pipe(Effect.orDie);

      assert.isTrue(
        Arr.some(
          projectionNames,
          ({ projection }) => projection === "PersonProfileRows"
        ),
        "the profile projection checkpoint is present"
      );

      const after = yield* Effect.forEach(personalValues, scanPersonalValue, {
        concurrency: 1,
      });

      assert.isTrue(Arr.every(after, Arr.isReadonlyArrayEmpty));

      const rows = yield* sql.unsafe(
        "select count(*)::int as count from alchemy_event where aggregate = $1 and id = $2",
        ["Person", String(personId)]
      );

      const [history] = rows;

      if (history === undefined) {
        return yield* Effect.die("erasure history query returned no row");
      }

      const decodedHistory = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ count: Schema.Finite })
      )(history).pipe(Effect.orDie);

      assert.strictEqual(decodedHistory.count, 2);

      const stateRows = yield* sql.unsafe(
        "select state from alchemy_aggregate where aggregate = $1 and id = $2",
        ["Person", String(personId)]
      );

      const [stateRow] = stateRows;

      if (stateRow === undefined) {
        return yield* Effect.die(
          "erasure aggregate state query returned no row"
        );
      }

      const decodedRow = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ state: Schema.Unknown })
      )(stateRow).pipe(Effect.orDie);

      const retainedState = yield* Schema.decodeUnknownEffect(
        PersonStateSchema
      )(decodedRow.state).pipe(Effect.orDie);

      assert.strictEqual(retainedState.memberships.length, 1);
      assert.strictEqual(retainedState.memberships[0]?.id, membershipId);

      return yield* Effect.void;
    }).pipe(Effect.provide(erasureWorld))
);
