/**
 * Spec 0007b falsifier 6: an administrator merges two records of one person. `mergePersons(into, from)` moves every row
 * of `from` to `into` by the merge rules of the catalog, in one transaction, and leaves a tombstone without personal data.
 * Overlapping memberships in one team, two accounts, and a place that would be granted by its holder refuse the merge with
 * a typed conflict and no change. Twenty concurrent merges of one pair, half in each direction, have one winner in each of
 * three hundred rounds of fresh state. A second Person cannot verify an
 * e-mail address that a verified Person holds.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  AlreadyExists,
  Conflict,
  PersonId,
  PersonRepository,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Order,
  Record as Rec,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { postgresDatabase } from "./support/database.ts";
import { failedWith, refusalOf } from "./support/failures.ts";
import {
  NAMING_TABLES,
  countWhere,
  mergeAs,
  rowsNaming,
} from "./support/personalDataActors.ts";
import { everything, nothing, seedPerson } from "./support/personData.ts";
import type { Seeded } from "./support/personData.ts";
import { describeExit, race, raceReport } from "./support/race.ts";
import { scan, snapshot } from "./support/snapshot.ts";
import { asPerson } from "./support/teamsWorld.ts";

const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00Z");
const EARLIER = DateTime.makeUnsafe("2026-10-26T12:00:00Z");
const LATER = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

/** An administrator who does the merging: a person with a place and an Active account, so that the grant is checked for real. */
const administrator = (tag: string) =>
  seedPerson(tag, { ...nothing, account: true, grant: true }, LATER);

/** The merge of `from` into `into` is refused, with `reason` in what it says, and no row of the database changed. */
const refusedWithoutChange = Effect.fnUntraced(function* refusedWithoutChange(
  admin: Seeded,
  into: Seeded,
  from: Seeded,
  reason: string
) {
  const before = yield* snapshot;

  const exit = yield* Effect.exit(
    mergeAs(admin.personId, into.personId, from.personId)
  );

  assert.include(refusalOf(exit), reason);
  assert.deepStrictEqual(yield* snapshot, before);
});

/** How many merges race in a round, and how many rounds there are, each with a pair of people of its own. */
const MERGES = 20;
const ROUNDS = 300;

/**
 * What a round of merges of the same two records must have left, whichever merge came first: exactly one succeeded and
 * every other lost with the typed conflict (not a defect, not a deadlock), one record is a tombstone, and the other
 * holds the memberships of both. The report names the round and prints each loser's whole Cause.
 */
const checkMergeRound = Effect.fnUntraced(function* checkMergeRound(
  round: number,
  exits: readonly Exit.Exit<unknown, unknown>[],
  pair: readonly [Seeded, Seeded]
) {
  const report = raceReport(round, exits);
  const [first, second] = pair;

  assert.strictEqual(Arr.filter(exits, Exit.isSuccess).length, 1, report);

  assert.isTrue(
    Arr.every(Arr.filter(exits, Exit.isFailure), (loser) =>
      failedWith(loser, Conflict)
    ),
    report
  );

  assert.strictEqual(
    yield* countWhere(
      "person",
      `id in (${first.personId}, ${second.personId}) and merged_into is not null`
    ),
    1,
    report
  );

  const held = Arr.sort(
    [
      (yield* rowsNaming(first.personId, NAMING_TABLES)).membership ?? 0,
      (yield* rowsNaming(second.personId, NAMING_TABLES)).membership ?? 0,
    ],
    Order.Number
  );

  assert.deepStrictEqual(held, [0, 2], report);
});

layer(postgresDatabase({ maxConnections: 30 }), { excludeTestServices: true })(
  "spec 0007b falsifier 6: merge",
  (it) => {
    it.effect(
      "moves every row of the merged person to the survivor by the catalog's rules, and leaves a tombstone without personal data",
      () =>
        Effect.gen(function* merge() {
          const sql = yield* SqlClient;
          const admin = yield* administrator("mgadmin");

          // The survivor: one older consent, a membership of their own, a digest and a request.
          const into: Seeded = yield* seedPerson(
            "mgsurvivor",
            {
              ...nothing,
              alumniRequest: true,
              digest: true,
              keepDetails: true,
              memberships: 1,
            },
            EARLIER
          );

          // The merged record: a newer consent and one more, two memberships, an account with its sessions, a code, a place,
          // an upload, mail, and a digest and a request that collide with the survivor's only when their keys are equal.
          const from: Seeded = yield* seedPerson(
            "mgmerged",
            { ...everything, alumniRequest: true, digest: true, photo: false },
            LATER
          );

          // A place that the merged person granted to a third person: the grant history keeps naming them.
          const third = yield* seedPerson("mgthird", nothing, LATER);

          yield* sql`insert into admin_grant (granted_by, person_id, until) values (${from.personId}, ${third.personId}, ${DateTime.toDateUtc(FAR)})`;

          const result = yield* mergeAs(
            admin.personId,
            into.personId,
            from.personId
          );

          assert.strictEqual(result.into, into.personId);

          // Every row of the merged person follows the survivor.
          assert.deepStrictEqual(
            yield* rowsNaming(from.personId, NAMING_TABLES),
            {}
          );

          const survivor = yield* rowsNaming(into.personId, NAMING_TABLES);

          assert.strictEqual(survivor.membership, 3);
          assert.strictEqual(survivor.account, 1);
          assert.strictEqual(survivor.auth_user, 1);
          assert.strictEqual(survivor.admin_grant, 1);
          assert.strictEqual(survivor.public_file, 1);

          // The newer decision stays: the survivor's keepDetails is now the merged person's, and news came across.
          const consents = yield* sql<{
            readonly given_at: Date;
            readonly kind: string;
          }>`select kind, given_at from consent where person_id = ${into.personId} order by kind`;

          assert.deepStrictEqual(
            Arr.map(consents, (row) => [row.kind, row.given_at.toISOString()]),
            [
              ["keepDetails", DateTime.formatIso(LATER)],
              ["news", DateTime.formatIso(LATER)],
            ]
          );

          // Keyed rows that would collide keep the survivor's: one digest of the term, and two requests of two dates.
          assert.strictEqual(survivor.ending_soon_digest, 1);
          assert.strictEqual(survivor.alumni_request, 2);

          // A code of the merged person is dropped: it belongs to a record that no longer exists.
          assert.isUndefined(survivor.code);

          // The tombstone: no personal data, a pointer to the survivor, and still a row for the history to name.
          const [tomb] = yield* sql<{
            readonly anonymised: boolean;
            readonly email: string;
            readonly merged_into: number | null;
            readonly name: string;
          }>`select anonymised_at is not null as anonymised, email, merged_into, name from person where id = ${from.personId}`;

          assert.deepStrictEqual(tomb, {
            anonymised: true,
            email: `anonymisert-${from.personId}@vektorprogrammet.invalid`,
            merged_into: into.personId,
            name: "Anonymisert",
          });

          assert.strictEqual(
            yield* countWhere("admin_grant", `granted_by = ${from.personId}`),
            1
          );

          // The tombstone holds none of the merged person's values: they are in the account that came across (the login the
          // survivor now has) and in the transport copies of mail that expire on their own, and nowhere else.
          const found = yield* scan(from.values);

          assert.deepStrictEqual(Arr.sort(Rec.keys(found), Order.String), [
            "auth_user",
            "captured_mail",
            "outbox",
          ]);

          // The survivor's own values are untouched, and the tombstone is not listed.
          assert.isAbove(Rec.size(yield* scan(into.values)), 0);

          const listed = yield* PersonRepository.use((people) =>
            people.list(null)
          );

          assert.notInclude(
            Arr.map(listed, (person) => person.id),
            from.personId
          );

          // The audit log says that it happened.
          assert.strictEqual(
            yield* countWhere(
              "audit_log",
              `action = 'person.merged' and entity_key = '${into.personId}'`
            ),
            1
          );
        })
    );

    it.effect(
      "an audit row follows the merge by its actor and keeps the entity key it names: what the merged record wrote is the survivor's, and a row about the merged record still names the tombstone, which points to the survivor",
      () =>
        Effect.gen(function* auditRows() {
          const sql = yield* SqlClient;
          const admin = yield* administrator("mgauditadmin");
          const into = yield* seedPerson("mgauditinto", nothing, LATER);
          const from = yield* seedPerson("mgauditfrom", nothing, LATER);
          const named = String(from.personId);

          // Two rows that mention the merged record: one that it wrote, and one that the administrator wrote about it.
          yield* sql`insert into audit_log (action, at, entity, entity_key, person_id)
            values ('person.photoSet', now(), 'Person', ${named}, ${from.personId}),
              ('account.invited', now(), 'Account', ${named}, ${admin.personId})`;

          yield* mergeAs(admin.personId, into.personId, from.personId);

          // By actor: the row that the merged record wrote is the survivor's now, and the tombstone has none.
          assert.strictEqual(
            yield* countWhere(
              "audit_log",
              `action = 'person.photoSet' and person_id = ${into.personId}`
            ),
            1
          );
          assert.strictEqual(
            yield* countWhere("audit_log", `person_id = ${from.personId}`),
            0
          );

          // By entity: both rows still name the tombstone, a record with no data that points to the survivor.
          assert.strictEqual(
            yield* countWhere(
              "audit_log",
              `entity_key = '${named}' and entity in ('Person', 'Account')`
            ),
            2
          );

          const [tomb] = yield* sql<{
            readonly merged_into: number | null;
          }>`select merged_into from person where id = ${from.personId}`;

          assert.strictEqual(tomb?.merged_into, into.personId);
        })
    );

    it.effect(
      "a second merge of the same person is refused: the tombstone cannot be locked or merged again",
      () =>
        Effect.gen(function* again() {
          const admin = yield* administrator("mgagainadmin");
          const into = yield* seedPerson("mgagaina", nothing, LATER);

          const from = yield* seedPerson(
            "mgagainb",
            { ...nothing, memberships: 1 },
            LATER
          );

          yield* mergeAs(admin.personId, into.personId, from.personId);
          const before = yield* snapshot;

          const second = yield* Effect.exit(
            mergeAs(admin.personId, into.personId, from.personId)
          );

          assert.isTrue(failedWith(second, Conflict));
          assert.deepStrictEqual(yield* snapshot, before);
        })
    );

    it.effect(
      "two accounts refuse the merge with a typed conflict, and nothing changes",
      () =>
        Effect.gen(function* twoAccounts() {
          const admin = yield* administrator("mgacctadmin");

          const into = yield* seedPerson(
            "mgacct1",
            { ...nothing, account: true },
            LATER
          );

          const from = yield* seedPerson(
            "mgacct2",
            { ...nothing, account: true, memberships: 1 },
            LATER
          );

          yield* refusedWithoutChange(admin, into, from, "konto");
        })
    );

    it.effect(
      "memberships that overlap in one team refuse the merge with a typed conflict, and nothing changes",
      () =>
        Effect.gen(function* overlap() {
          const sql = yield* SqlClient;
          const admin = yield* administrator("mgoverlapadmin");

          const into = yield* seedPerson(
            "mgoverlap1",
            { ...nothing, memberships: 1 },
            LATER
          );

          const from = yield* seedPerson(
            "mgoverlap2",
            { ...nothing, memberships: 1 },
            LATER
          );

          // The merged person was a member of the survivor's team in the survivor's own semester (HOST 2021).
          yield* sql`update membership set team_id = ${into.teamId} where person_id = ${from.personId}`;

          yield* refusedWithoutChange(admin, into, from, "overlapper");
        })
    );

    it.effect(
      "a place that would be granted by its own holder refuses the merge, and nothing changes",
      () =>
        Effect.gen(function* selfGrant() {
          const sql = yield* SqlClient;
          const admin = yield* administrator("mgselfadmin");
          const into = yield* seedPerson("mgself1", nothing, LATER);
          const from = yield* seedPerson("mgself2", nothing, LATER);

          // The survivor granted the merged person a place: after the merge the survivor would hold a place that they gave themselves.
          yield* sql`insert into admin_grant (granted_by, person_id, until) values (${into.personId}, ${from.personId}, ${DateTime.toDateUtc(FAR)})`;

          yield* refusedWithoutChange(admin, into, from, "administratorplass");
        })
    );

    it.effect(
      `${MERGES} concurrent merges of one pair, half in each direction, have one winner in each of ${ROUNDS} rounds of fresh state, and the others lose with the typed conflict`,
      () =>
        Effect.gen(function* concurrent() {
          const admin = yield* administrator("mgraceadmin");

          for (const round of Arr.range(1, ROUNDS)) {
            const first = yield* seedPerson(
              `mgrace${round}a`,
              { ...nothing, memberships: 1 },
              LATER
            );

            const second = yield* seedPerson(
              `mgrace${round}b`,
              { ...nothing, memberships: 1 },
              LATER
            );

            // Opposite orders of the same two rows: without one global order of the locks (the admin list, then both
            // people in ascending id order) a merge of the first into the second and one of the second into the first
            // would wait for each other.
            const exits = yield* race(
              Arr.makeBy(MERGES, (index) =>
                index % 2 === 0
                  ? mergeAs(admin.personId, first.personId, second.personId)
                  : mergeAs(admin.personId, second.personId, first.personId)
              )
            );

            yield* checkMergeRound(round, exits, [first, second]);
          }
        }),
      // 300 rounds of seeding two people and racing twenty transactions: about a minute and a half on a loaded machine.
      { timeout: 280_000 }
    );

    it.effect(
      "negative control: a round in which two merges succeed, or in which one dies, fails the check, and its report holds the Cause",
      () =>
        Effect.gen(function* checkCanFail() {
          const pair = [
            yield* seedPerson("mgctrl1", nothing, LATER),
            yield* seedPerson("mgctrl2", nothing, LATER),
          ] as const;

          const twoWinners = yield* Effect.exit(
            checkMergeRound(1, [Exit.succeed(1), Exit.succeed(2)], pair)
          );

          assert.isTrue(Exit.isFailure(twoWinners));

          const oneDied = yield* Effect.exit(
            checkMergeRound(
              2,
              [Exit.succeed(1), Exit.die("a defect named boom")],
              pair
            )
          );

          assert.isTrue(Exit.isFailure(oneDied));
          assert.include(describeExit(oneDied), "a defect named boom");
          assert.include(describeExit(oneDied), "round 2");
        })
    );

    it.effect(
      "a second Person cannot verify an e-mail address that a verified Person holds",
      () =>
        Effect.gen(function* verify() {
          const sql = yield* SqlClient;
          const holder = yield* seedPerson("mgverify1", nothing, LATER);
          const other = yield* seedPerson("mgverify2", nothing, LATER);

          // Both hold the address, but only the holder has verified it.
          yield* sql`update person set email = ${holder.email}, email_verified = true where id = ${holder.personId}`;
          yield* sql`update person set email = ${holder.email} where id = ${other.personId}`;

          const exit = yield* Effect.exit(
            asPerson(PersonId.make(other.personId), (locked) =>
              AccountRepository.use((accounts) => accounts.verifyEmail(locked))
            )
          );

          assert.isTrue(failedWith(exit, AlreadyExists));

          const [row] = yield* sql<{
            readonly email_verified: boolean;
          }>`select email_verified from person where id = ${other.personId}`;

          assert.isFalse(row?.email_verified);
        })
    );
  }
);
