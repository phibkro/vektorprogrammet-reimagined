/**
 * Spec 0007b falsifier 3: `exportMyData(p)` returns exactly the rows keyed by p. A property over generated multi-person
 * data finds no other person's value in the export (and no credential of p's own, which the catalog excludes by
 * column), and a test over the catalog finds every table that a person's rows live in either exported or declared as an
 * exclusion with a reason. The negative control shows that the property can fail: an export that leaves out the person
 * filter holds the others' values.
 */
import { assert, layer } from "@effect/vitest";
import {
  Catalog,
  CurrentPrincipal,
  PersonId,
  PersonalDataEndpoints,
  PersonalDataStore,
  Principal,
  excludedTables,
  exportedTables,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Order,
  Record as Rec,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { encodeJson } from "./support/json.ts";
import { Holdings, everything, seedPerson } from "./support/personData.ts";
import type { Seeded } from "./support/personData.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

/** A person exports their own data: signed in, with no admin place. */
const selfPrincipal = (personId: number) =>
  Principal.cases.Person.make({
    memberships: [],
    personId: PersonId.make(personId),
  });

const exportAs = (personId: number) =>
  transactional(
    PersonalDataEndpoints.exportMyData({ personId }).pipe(
      Effect.provideService(CurrentPrincipal, selfPrincipal(personId))
    )
  );

const exportOf = (personId: number) =>
  PersonalDataStore.use((store) =>
    store.exportOf(PersonId.make(personId), NOW)
  );

const countOf = (
  exported: { readonly tables: Readonly<Record<string, readonly unknown[]>> },
  table: string
) => exported.tables[table]?.length ?? 0;

/** What the export of this person must hold, table by table, from the holdings that were seeded. */
const expectedRows = (seeded: Seeded) => ({
  account: seeded.holdings.account ? 1 : 0,
  admin_grant: seeded.holdings.grant ? 1 : 0,
  alumni_request: seeded.holdings.alumniRequest ? 1 : 0,
  auth_session: seeded.holdings.account ? 1 : 0,
  auth_user: seeded.holdings.account ? 1 : 0,
  code: seeded.holdings.code ? 1 : 0,
  consent:
    Number(seeded.holdings.keepDetails) +
    Number(seeded.holdings.news) +
    Number(seeded.holdings.photo),
  ending_soon_digest: seeded.holdings.digest ? 1 : 0,
  membership: seeded.holdings.memberships,
  person: 1,
  public_file: seeded.holdings.file ? 1 : 0,
});

/** Everything that belongs to one person alone: their values and their secrets. */
const ownedBy = (seeded: Seeded): readonly string[] => [
  ...seeded.values,
  ...seeded.secrets,
];

/** The values of the others that the person's export holds, if any: what the property looks for. */
const leaked = (
  text: string,
  me: Seeded,
  everyone: readonly Seeded[]
): readonly string[] =>
  Arr.filter(
    Arr.flatMap(
      Arr.filter(everyone, (other) => other.personId !== me.personId),
      ownedBy
    ),
    (value) => text.includes(value)
  );

/** A counter for the tags of the generated rounds: every round writes people of its own into the one database. */
const rounds = { count: 0 };

const People = Schema.Array(Holdings).check(Schema.isBetweenLength(2, 4));

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b falsifier 3: the export holds exactly the rows keyed by the person",
  (it) => {
    it.effect(
      "a person's export holds their own rows in every table, no other person's value, and none of the declared credential columns",
      () =>
        Effect.gen(function* oneExport() {
          const ola = yield* seedPerson("exola", everything, NOW);
          const kari = yield* seedPerson("exkari", everything, NOW);

          const exported = yield* exportAs(ola.personId);
          const text = yield* encodeJson(exported);

          for (const own of ola.values) {
            assert.include(text, own);
          }

          assert.deepStrictEqual(leaked(text, ola, [ola, kari]), []);

          // The credentials of the person's own are columns that the catalog excludes: no password hash, session token or code hash.
          for (const secret of ola.secrets) {
            assert.notInclude(text, secret);
          }

          for (const [table, rows] of Rec.toEntries(expectedRows(ola))) {
            assert.strictEqual(countOf(exported, table), rows, table);
          }

          // Exactly the tables that the catalog says: every `Rows` table, and none of the excluded ones.
          assert.deepStrictEqual(
            Arr.sort(Rec.keys(exported.tables), Order.String),
            Arr.sort(
              Arr.map(exportedTables(Catalog), ({ table }) => table),
              Order.String
            )
          );

          for (const { table } of excludedTables(Catalog)) {
            assert.isUndefined(exported.tables[table]);
          }

          assert.strictEqual(exported.personId, ola.personId);
        })
    );

    it.effect.prop(
      "property: over generated data for several people, nobody's export holds another person's value, and each holds exactly its own rows",
      { people: People },
      ({ people }) =>
        Effect.gen(function* property() {
          rounds.count += 1;
          const round = rounds.count;

          const seeded = yield* Effect.forEach(people, (holdings, index) =>
            seedPerson(`prop${round}x${index}`, holdings, NOW)
          );

          for (const me of seeded) {
            const exported = yield* exportOf(me.personId);
            const text = yield* encodeJson(exported);

            assert.deepStrictEqual(leaked(text, me, seeded), []);

            for (const secret of me.secrets) {
              assert.notInclude(text, secret);
            }

            for (const own of me.values) {
              assert.include(text, own);
            }

            for (const [table, rows] of Rec.toEntries(expectedRows(me))) {
              assert.strictEqual(
                countOf(exported, table),
                rows,
                `${table} of ${me.tag}`
              );
            }
          }
        }),
      { arbitrary: { runs: 25 } }
    );

    it.effect(
      "negative control: an export that selects every person's rows holds the others' values, and the property's check finds them",
      () =>
        Effect.gen(function* withoutTheFilter() {
          const sql = yield* SqlClient;
          const ola = yield* seedPerson("ctrlola", everything, NOW);
          const kari = yield* seedPerson("ctrlkari", everything, NOW);

          // The statement that the export would be without `where person_id = …`: every person row, whoever's.
          const rows = yield* sql<{
            readonly name: string;
          }>`select name from person`;

          const text = yield* encodeJson(rows);

          assert.deepStrictEqual(
            Arr.filter(kari.values, (value) => text.includes(value)),
            [kari.name]
          );

          assert.isAbove(leaked(text, ola, [ola, kari]).length, 0);
        })
    );

    it.effect(
      "an export of nobody is not an empty file: the person must exist",
      () =>
        Effect.gen(function* nobody() {
          const exit = yield* Effect.exit(exportAs(2_000_000));

          assert.isTrue(Exit.isFailure(exit));
        })
    );
  }
);
