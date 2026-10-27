/**
 * Spec 0007b falsifier 4: erasure. `erasePerson` runs the person core's `onExpiry` now: it anonymises the person, deletes
 * the account, the sessions, the consents, the codes and the other rows that live and die with the person core, and keeps
 * the history rows. With a blocking hold, or when it would remove the last Active administrator, it is refused with the
 * reason and nothing changes. A hold that only keeps rows is reported with its end date. A second call changes nothing,
 * and a scan finds no value of the erased person outside the held rows; skipping the person core fails the scan.
 */
import { assert, layer } from "@effect/vitest";
import {
  AggregateLocks,
  Catalog,
  LegalHolds,
  PersonId,
  PersonalDataEndpoints,
  PersonalDataStore,
  retentionRules,
} from "@vektorprogrammet/domain";
import type { Hold, Principal } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Exit, Record as Rec } from "effect";

import { Aggregates } from "../src/aggregate/aggregates.ts";
import { personalDataRetention } from "../src/personalData/retention.ts";
import { activeAdmin, noAdmins } from "./support/accountsWorld.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { refusalOf } from "./support/failures.ts";
import {
  adminPrincipal,
  countWhere,
  rowsNaming,
  runAs,
  selfPrincipal,
} from "./support/personalDataActors.ts";
import { everything, seedPerson } from "./support/personData.ts";
import type { Seeded } from "./support/personData.ts";
import { scan, snapshot } from "./support/snapshot.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00Z");
const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00Z");

/** `actor` asks for the erasure of `personId`, in a transaction of its own. */
const eraseAs = (actor: Principal, personId: number) =>
  runAs(actor, PersonalDataEndpoints.erasePerson({ personId }));

/** The tables that an erasure takes a person's rows out of or leaves them in. */
const ERASED_TABLES = [
  "account",
  "admin_grant",
  "alumni_request",
  "auth_account",
  "auth_session",
  "auth_user",
  "code",
  "consent",
  "ending_soon_digest",
  "membership",
  "public_file",
] as const;

/** The tables of `ERASED_TABLES` that still have rows naming `personId`, and how many. */
const rowsLeft = (personId: number) => rowsNaming(personId, ERASED_TABLES);

const auditedErasures = (personId: number) =>
  countWhere(
    "audit_log",
    `action = 'person.erased' and entity_key = '${personId}'`
  );

/** A hold for the tests: a source that says why, until when, and whether erasure may go ahead. */
const holding = (hold: Hold) =>
  Effect.provideService(
    LegalHolds,
    LegalHolds.of({ of: () => Effect.succeed([hold]) })
  );

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b falsifier 4: erasure",
  (it) => {
    it.effect(
      "erasePerson anonymises the person core, deletes what lives and dies with it, keeps the history rows, and a scan finds none of the person's values",
      () =>
        Effect.gen(function* erasure() {
          const ola: Seeded = yield* seedPerson("erola", everything, NOW);
          const kari: Seeded = yield* seedPerson("erkari", everything, NOW);
          const karisRowsBefore = yield* rowsLeft(kari.personId);

          const result = yield* eraseAs(
            selfPrincipal(ola.personId),
            ola.personId
          );

          assert.isTrue(result.erased);
          assert.deepStrictEqual(result.held, []);

          // The history stays: two memberships and the place on the admin list. Everything that lived and died with the
          // person core is gone, so no other table names them.
          assert.deepStrictEqual(yield* rowsLeft(ola.personId), {
            admin_grant: 1,
            membership: 2,
          });

          // Nothing of the person's was written down anywhere but the held rows, and those hold no value (ids only).
          assert.deepStrictEqual(
            yield* scan([...ola.values, ...ola.secrets]),
            {}
          );

          assert.strictEqual(yield* auditedErasures(ola.personId), 1);

          // Kari's rows are as they were: the erasure touched the person and nothing of anyone else's.
          assert.deepStrictEqual(
            yield* rowsLeft(kari.personId),
            karisRowsBefore
          );
          assert.isAbove(Rec.size(yield* scan(kari.values)), 0);
        })
    );

    it.effect(
      "a second call changes nothing, and writes no second audit row",
      () =>
        Effect.gen(function* second() {
          const ola = yield* seedPerson("ersecond", everything, NOW);
          yield* seedPerson("ersecondother", everything, NOW);

          yield* eraseAs(selfPrincipal(ola.personId), ola.personId);
          const afterFirst = yield* snapshot;

          const again = yield* eraseAs(
            selfPrincipal(ola.personId),
            ola.personId
          );

          assert.isFalse(again.erased);
          assert.deepStrictEqual(yield* snapshot, afterFirst);
          assert.strictEqual(yield* auditedErasures(ola.personId), 1);
        })
    );

    it.effect(
      "negative control: an erasure that skips the person core leaves the person's name and address, and the scan finds them",
      () =>
        Effect.gen(function* skipping() {
          const ola = yield* seedPerson("erskip", everything, NOW);

          const aggregates = yield* Aggregates;
          const db = yield* Drizzle;
          const locks = yield* AggregateLocks;
          const real = yield* PersonalDataStore;

          const withoutPerson = personalDataRetention(
            { aggregates, db, locks },
            Arr.filter(
              retentionRules(Catalog),
              (rule) => rule.table !== "person"
            )
          );

          const skipped = PersonalDataStore.of({
            ...real,
            erase: withoutPerson.erase,
          });

          yield* eraseAs(selfPrincipal(ola.personId), ola.personId).pipe(
            Effect.provideService(PersonalDataStore, skipped)
          );

          const found = yield* scan(ola.values);

          assert.deepStrictEqual(Rec.keys(found), ["person"]);
          assert.isAbove(found.person ?? 0, 0);
        })
    );

    it.effect(
      "erasure that would remove the last Active administrator is refused with the reason, and nothing changes; with another administrator it goes ahead",
      () =>
        Effect.gen(function* lastAdmin() {
          yield* noAdmins;

          const only = yield* seedPerson(
            "eronly",
            { ...everything, account: false, grant: false },
            NOW
          );

          yield* activeAdmin(PersonId.make(only.personId), FAR);
          const before = yield* snapshot;

          const refused = yield* Effect.exit(
            eraseAs(selfPrincipal(only.personId), only.personId)
          );

          assert.include(refusalOf(refused), "siste administratoren");

          assert.deepStrictEqual(yield* snapshot, before);

          // A second Active administrator takes the place: the same erasure now goes ahead.
          const other = yield* seedPerson(
            "erother",
            { ...everything, account: false, grant: false },
            NOW
          );

          yield* activeAdmin(PersonId.make(other.personId), FAR);

          const done = yield* eraseAs(
            selfPrincipal(only.personId),
            only.personId
          );

          assert.isTrue(done.erased);
        })
    );

    it.effect(
      "a blocking hold refuses the erasure with its reason and nothing changes; a hold that only keeps rows lets it go ahead and is reported with its end date",
      () =>
        Effect.gen(function* holds() {
          const ola = yield* seedPerson("erhold", everything, NOW);
          const before = yield* snapshot;

          const open: Hold = {
            blocks: true,
            reason: "Et åpent utlegg må behandles først.",
            source: "expenseClaim",
            until: null,
          };

          const refused = yield* Effect.exit(
            eraseAs(selfPrincipal(ola.personId), ola.personId).pipe(
              holding(open)
            )
          );

          assert.isTrue(Exit.isFailure(refused));
          assert.deepStrictEqual(yield* snapshot, before);

          const kept: Hold = {
            blocks: false,
            reason: "Utlegget er bokført og oppbevares i fem år.",
            source: "expenseClaim",
            until: DateTime.makeUnsafe("2031-10-27T12:00:00Z"),
          };

          const done = yield* eraseAs(
            selfPrincipal(ola.personId),
            ola.personId
          ).pipe(holding(kept));

          assert.isTrue(done.erased);

          assert.deepStrictEqual(
            Arr.map(done.held, ({ reason, source, until }) => [
              reason,
              source,
              until === null ? null : DateTime.formatIso(until),
            ]),
            [[kept.reason, kept.source, "2031-10-27T12:00:00.000Z"]]
          );
        })
    );

    it.effect("an administrator can erase anyone; another person cannot", () =>
      Effect.gen(function* authority() {
        // No tag is the start of another: a scan for one person's name must not match another's.
        const ola = yield* seedPerson(
          "erauth1",
          { ...everything, grant: false },
          NOW
        );

        const kari = yield* seedPerson(
          "erauth2",
          { ...everything, grant: false },
          NOW
        );

        const admin = yield* seedPerson(
          "erauth3",
          { ...everything, grant: false },
          NOW
        );

        const before = yield* snapshot;

        const refused = yield* Effect.exit(
          eraseAs(selfPrincipal(kari.personId), ola.personId)
        );

        assert.isTrue(Exit.isFailure(refused));
        assert.deepStrictEqual(yield* snapshot, before);

        const done = yield* eraseAs(
          adminPrincipal(admin.personId),
          ola.personId
        );

        assert.isTrue(done.erased);
        assert.deepStrictEqual(yield* scan(ola.values), {});
      })
    );
  }
);
