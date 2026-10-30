/**
 * Spec 0026: the end of an admin place that retention deleted stays on the person (`person.last_admin_place_end`), so that
 * a person with a current `keepDetails` consent is anonymised five years after their last activity and not on the night
 * three years after their place ended. F1 consecutive nightly runs, with the finding itself as the negative control (a
 * store without `keeps` anonymises the person two years early), F2 consent withdrawal, F3 several places and a membership,
 * F4 merge, F5 export and erasure, F6 a changed place period (the date is never written to an anonymised person) and F7
 * the production mode that only counts.
 */
import { assert, layer } from "@effect/vitest";
import {
  AggregateLocks,
  Catalog,
  PersonalDataDeclaration,
  PersonalDataEndpoints,
  afterDuration,
  retentionRules,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { Aggregates } from "../src/aggregate/aggregates.ts";
import { transactional } from "../src/index.ts";
import { personalDataRetention } from "../src/personalData/retention.ts";
import {
  Drizzle,
  postgresDatabase,
  postgresJobDatabase,
} from "./support/database.ts";
import { encodeJson } from "./support/json.ts";
import { mergeAs, runAs, selfPrincipal } from "./support/personalDataActors.ts";
import { nothing, seedPerson } from "./support/personData.ts";
import { at, runRetention } from "./support/retentionRun.ts";
import { world } from "./support/teamsWorld.ts";

const { period, years } = PersonalDataDeclaration;

const T0 = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

/** The end of the place that every scenario starts from. */
const U = DateTime.makeUnsafe("2027-03-01T00:00:00Z");

const day = (instant: DateTime.Utc, days: number) =>
  DateTime.add(instant, { days });

/** The night one day after the place's period of `placeYears` is over. */
const afterPlace = (until: DateTime.Utc, placeYears: number, days = 1) =>
  day(afterDuration(until, years(placeYears)), days);

const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant);

/** What the tests ask of a person: anonymised or not, the kept date as ISO text, and how many places remain. */
const stateOf = Effect.fnUntraced(function* stateOf(id: number) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly anonymised: boolean;
    readonly kept: Date | string | null;
    readonly places: number;
  }>`select anonymised_at is not null as anonymised, last_admin_place_end as kept,
    (select count(*)::int from admin_grant where person_id = person.id) as places
    from person where id = ${id}`;

  assert.isDefined(row);

  return {
    anonymised: row.anonymised,
    kept:
      row.kept === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(row.kept)),
    places: row.places,
  };
});

const addPlace = Effect.fnUntraced(function* addPlace(
  personId: number,
  until: DateTime.Utc
) {
  const sql = yield* SqlClient;

  yield* sql`insert into admin_grant (person_id, until) values (${personId}, ${DateTime.toDateUtc(until)})`;
});

const giveKeepDetails = Effect.fnUntraced(function* giveKeepDetails(
  personId: number
) {
  const sql = yield* SqlClient;

  yield* sql`insert into consent (given_at, kind, person_id, text_version)
    values (${DateTime.toDateUtc(T0)}, 'keepDetails', ${personId}, 1)`;
});

/** The kept date of a person, written as a fixture (`null` clears it). */
const setKept = Effect.fnUntraced(function* setKept(
  personId: number,
  kept: string | null
) {
  const sql = yield* SqlClient;

  yield* sql`update person set last_admin_place_end = ${kept === null ? null : DateTime.toDateUtc(DateTime.makeUnsafe(kept))} where id = ${personId}`;
});

/** A membership that ended with Høst 2020: without the place, the person's last activity is long past. */
const oldMembership = Effect.fnUntraced(function* oldMembership(
  fixture: Effect.Success<ReturnType<typeof world>>
) {
  const sql = yield* SqlClient;

  yield* sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
    values ('HOST', 2020, ${fixture.person.id}, ${fixture.memberPosition}, 'HOST', 2020, ${fixture.team.id})`;
});

const night = Effect.fnUntraced(function* night(instant: DateTime.Utc) {
  yield* at(instant);
  yield* runRetention;
});

/** The nightly run of a store built over `rules`: the real run, or one that the test has changed. */
const storeOver = Effect.fnUntraced(function* storeOver(
  rules: ReturnType<typeof retentionRules>
) {
  const aggregates = yield* Aggregates;
  const db = yield* Drizzle;
  const locks = yield* AggregateLocks;
  const store = personalDataRetention({ aggregates, db, locks }, rules);

  return (now: DateTime.Utc) =>
    transactional(store.expire(now)).pipe(Effect.orDie);
});

const rules = retentionRules(Catalog);

/** The catalog's rules with the admin place's period changed to `placeYears`. */
const withPlacePeriod = (placeYears: number) =>
  Arr.map(rules, (rule) =>
    rule.table === "admin_grant"
      ? {
          ...rule,
          retention: {
            ...rule.retention,
            period: period(years(placeYears), "decided"),
          },
        }
      : rule
  );

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0026: the end of a deleted admin place stays on the person",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "F1: consecutive nightly runs: the place goes at three years and the date stays; a keepDetails person is anonymised at five, a person without the consent at one (their place row goes later with no date)",
        () =>
          Effect.gen(function* consecutiveNights() {
            yield* at(T0);
            const beritWorld = yield* world("pe1");
            const berit = beritWorld.person.id;
            const cato = (yield* world("pe2")).person.id;
            yield* oldMembership(beritWorld);
            yield* giveKeepDetails(berit);
            yield* addPlace(berit, U);
            yield* addPlace(cato, U);

            const kept = DateTime.toDateUtc(U).toISOString();

            // One year minus a day: both places are there, nobody has a date, nobody is anonymised.
            yield* night(afterPlace(U, 1, -1));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: false,
              kept: null,
              places: 1,
            });

            assert.deepStrictEqual(yield* stateOf(cato), {
              anonymised: false,
              kept: null,
              places: 1,
            });

            // One year and a day: Cato's period (one year after the place) is over, his row is not.
            yield* night(afterPlace(U, 1));

            assert.deepStrictEqual(yield* stateOf(cato), {
              anonymised: true,
              kept: null,
              places: 1,
            });

            assert.isFalse((yield* stateOf(berit)).anonymised);

            // Three years minus a day: still there, and still nobody has a date.
            yield* night(afterPlace(U, 3, -1));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: false,
              kept: null,
              places: 1,
            });

            assert.deepStrictEqual(yield* stateOf(cato), {
              anonymised: true,
              kept: null,
              places: 1,
            });

            // Three years and a day: Berit's place is gone and its end is on her; Cato's row goes and nothing is written to him.
            yield* night(afterPlace(U, 3));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: false,
              kept,
              places: 0,
            });

            assert.deepStrictEqual(yield* stateOf(cato), {
              anonymised: true,
              kept: null,
              places: 0,
            });

            // A second run, and one the day after, change nothing.
            yield* night(afterPlace(U, 3, 2));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: false,
              kept,
              places: 0,
            });

            // Five years minus a day: still intact. Five years and a day: anonymised, and the date goes with her core.
            yield* night(afterPlace(U, 5, -1));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: false,
              kept,
              places: 0,
            });

            yield* night(afterPlace(U, 5));

            assert.deepStrictEqual(yield* stateOf(berit), {
              anonymised: true,
              kept: null,
              places: 0,
            });
          })
      );

      it.effect(
        "F3b: places that fall due on the same night keep the latest end, and the date a person already holds is never lowered by an earlier place",
        () =>
          Effect.gen(function* sameNight() {
            yield* at(T0);
            const xenia = (yield* world("pe8")).person.id;
            const yngve = (yield* world("pe9")).person.id;
            const first = DateTime.makeUnsafe("2027-03-01T00:00:00Z");
            const second = DateTime.makeUnsafe("2027-09-01T00:00:00Z");
            const held = DateTime.makeUnsafe("2029-01-01T00:00:00Z");

            for (const id of [xenia, yngve]) {
              yield* giveKeepDetails(id);
              yield* addPlace(id, first);
            }

            // Xenia's second place ends later; both are due when the first run after them comes (the first night after
            // approval deletes every old place at once). Yngve already holds a later date than either place.
            yield* addPlace(xenia, second);
            yield* setKept(yngve, iso(held));

            yield* night(afterPlace(second, 3));

            assert.deepStrictEqual(yield* stateOf(xenia), {
              anonymised: false,
              kept: iso(second),
              places: 0,
            });

            assert.deepStrictEqual(yield* stateOf(yngve), {
              anonymised: false,
              kept: iso(held),
              places: 0,
            });
          })
      );

      it.effect(
        "F4b: a survivor who got a later date from a merge keeps it when her own older place is deleted afterwards",
        () =>
          Effect.gen(function* mergedThenDeleted() {
            yield* at(T0);

            const admin = yield* seedPerson(
              "pm0",
              { ...nothing, account: true, grant: true },
              T0
            );

            const survivor = (yield* world("pm1")).person.id;
            const merged = (yield* world("pm2")).person.id;
            const later = DateTime.makeUnsafe("2028-09-01T00:00:00Z");

            yield* giveKeepDetails(survivor);
            yield* addPlace(survivor, U);
            yield* setKept(merged, iso(later));

            yield* mergeAs(admin.personId, survivor, merged);

            assert.strictEqual((yield* stateOf(survivor)).kept, iso(later));

            // Her place (earlier than the date she was given) is due and goes: the date stays the later one.
            yield* night(afterPlace(U, 3));

            assert.deepStrictEqual(yield* stateOf(survivor), {
              anonymised: false,
              kept: iso(later),
              places: 0,
            });
          })
      );

      it.effect(
        "F2: withdrawing keepDetails after the place went: the period falls back to one year from the same end, so the person is anonymised on the next night; with the consent kept she is not",
        () =>
          Effect.gen(function* withdrawal() {
            yield* at(T0);
            const dina = (yield* world("pe3")).person.id;
            const edel = (yield* world("pe4")).person.id;

            for (const id of [dina, edel]) {
              yield* giveKeepDetails(id);
              yield* addPlace(id, U);
            }

            yield* night(afterPlace(U, 3));

            for (const id of [dina, edel]) {
              assert.deepStrictEqual(yield* stateOf(id), {
                anonymised: false,
                kept: DateTime.toDateUtc(U).toISOString(),
                places: 0,
              });
            }

            const sql = yield* SqlClient;

            yield* sql`update consent set withdrawn_at = ${DateTime.toDateUtc(afterPlace(U, 3))}
              where person_id = ${dina} and kind = 'keepDetails'`;

            yield* night(afterPlace(U, 3, 2));

            assert.deepStrictEqual(yield* stateOf(dina), {
              anonymised: true,
              kept: null,
              places: 0,
            });

            assert.isFalse((yield* stateOf(edel)).anonymised);
          })
      );

      it.effect(
        "F3: several places that end on different nights, and a membership that ends after them all: the person's period follows the greatest end, at every night",
        () =>
          Effect.gen(function* severalPlaces() {
            yield* at(T0);
            const erik = yield* world("pe5");
            const frida = yield* world("pe6");
            const sql = yield* SqlClient;

            const first = DateTime.makeUnsafe("2027-03-01T00:00:00Z");
            const second = DateTime.makeUnsafe("2028-03-01T00:00:00Z");
            const third = DateTime.makeUnsafe("2031-03-01T00:00:00Z");

            for (const { person } of [erik, frida]) {
              yield* giveKeepDetails(person.id);

              for (const until of [first, second, third]) {
                yield* addPlace(person.id, until);
              }
            }

            // Frida's last membership ends with Vår 2032 (1 August 2032), after every place.
            yield* sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
              values ('VAR', 2032, ${frida.person.id}, ${frida.memberPosition}, 'VAR', 2032, ${frida.team.id})`;

            const keptOf = (id: number) =>
              Effect.map(stateOf(id), ({ kept, places }) => ({ kept, places }));

            yield* night(afterPlace(first, 3));

            assert.deepStrictEqual(yield* keptOf(erik.person.id), {
              kept: iso(first),
              places: 2,
            });

            yield* night(afterPlace(second, 3));

            assert.deepStrictEqual(yield* keptOf(erik.person.id), {
              kept: iso(second),
              places: 1,
            });

            yield* night(afterPlace(third, 3));

            assert.deepStrictEqual(yield* keptOf(erik.person.id), {
              kept: iso(third),
              places: 0,
            });

            // Five years after the greatest place end: Erik is intact a day before and anonymised a day after; Frida's
            // membership ends later, so she is intact, with the same date on her.
            yield* night(afterPlace(third, 5, -1));
            assert.isFalse((yield* stateOf(erik.person.id)).anonymised);

            yield* night(afterPlace(third, 5));

            assert.deepStrictEqual(yield* stateOf(erik.person.id), {
              anonymised: true,
              kept: null,
              places: 0,
            });

            assert.deepStrictEqual(yield* stateOf(frida.person.id), {
              anonymised: false,
              kept: iso(third),
              places: 0,
            });

            // Five years after the membership's end she is anonymised too.
            yield* night(DateTime.makeUnsafe("2037-07-30T00:00:00Z"));
            assert.isFalse((yield* stateOf(frida.person.id)).anonymised);

            yield* night(DateTime.makeUnsafe("2037-08-02T00:00:00Z"));

            assert.deepStrictEqual(yield* stateOf(frida.person.id), {
              anonymised: true,
              kept: null,
              places: 0,
            });
          })
      );

      for (const placeYears of [1, 5, 6]) {
        it.effect(
          `F6: a place period of ${placeYears} year(s): a keepDetails person is anonymised at five years from the end, and an anonymised person never holds a date`,
          () =>
            Effect.gen(function* changedPeriod() {
              yield* at(T0);
              const person = (yield* world(`pe7${placeYears}`)).person.id;
              yield* giveKeepDetails(person);
              yield* addPlace(person, U);

              const run = yield* storeOver(withPlacePeriod(placeYears));

              const nightOf = Effect.fnUntraced(function* nightOf(
                instant: DateTime.Utc
              ) {
                yield* at(instant);
                yield* run(instant);
              });

              // Intact a day before five years, whatever the place period is.
              yield* nightOf(afterPlace(U, 5, -1));

              assert.isFalse((yield* stateOf(person)).anonymised);

              yield* nightOf(afterPlace(U, 5));

              const state = yield* stateOf(person);

              // Anonymised at five years in every case, and the record holds no date: it was cleared with the core, or it
              // was never written, because the person was already anonymised when the place went.
              assert.isTrue(state.anonymised);
              assert.isNull(state.kept);

              // A place period of six years leaves the row a year longer; it goes with no date written.
              yield* nightOf(afterPlace(U, 6));

              assert.deepStrictEqual(yield* stateOf(person), {
                anonymised: true,
                kept: null,
                places: 0,
              });
            })
        );
      }
    });
  }
);

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0026 F1, negative control: the finding itself",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "a store whose rules do not keep the end anonymises a keepDetails person on the second night after the place went, two years before her five",
        () =>
          Effect.gen(function* withoutKeeps() {
            yield* at(T0);
            const fixture = yield* world("pc1");
            const person = fixture.person.id;
            yield* oldMembership(fixture);
            yield* giveKeepDetails(person);
            yield* addPlace(person, U);

            const run = yield* storeOver(
              Arr.map(rules, (rule) => ({ ...rule, keeps: undefined }))
            );

            // The night after three years: the place goes (the person's facts were read before it did, so she is not due yet).
            yield* at(afterPlace(U, 3));
            yield* run(afterPlace(U, 3));

            assert.deepStrictEqual(yield* stateOf(person), {
              anonymised: false,
              kept: null,
              places: 0,
            });

            // The next night her last activity has fallen back to her creation: anonymised, two years early.
            yield* at(afterPlace(U, 3, 2));
            yield* run(afterPlace(U, 3, 2));

            assert.deepStrictEqual(yield* stateOf(person), {
              anonymised: true,
              kept: null,
              places: 0,
            });
          })
      );
    });
  }
);

layer(postgresJobDatabase("ReportOnly"), { excludeTestServices: true })(
  "spec 0026 F7: the production mode only counts",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "a run that only counts writes no date and deletes no place",
        () =>
          Effect.gen(function* reportOnly() {
            yield* at(T0);
            const person = (yield* world("pr1")).person.id;
            yield* giveKeepDetails(person);
            yield* addPlace(person, U);

            yield* night(afterPlace(U, 3));

            assert.deepStrictEqual(yield* stateOf(person), {
              anonymised: false,
              kept: null,
              places: 1,
            });

            const sql = yield* SqlClient;

            const [reported] = yield* sql<{ readonly n: number }>`
              select count(*)::int as n from audit_log where action = 'retention.reported'`;

            assert.isAbove(reported?.n ?? 0, 0);
          })
      );
    });
  }
);

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0026 F4 and F5: merge, export and erasure",
  (it) => {
    const FAR_AGO = DateTime.makeUnsafe("2026-10-26T12:00:00Z");

    const keptOf = Effect.fnUntraced(function* keptOf(personId: number) {
      const state = yield* stateOf(personId);

      return state.kept;
    });

    const administrator = (tag: string) =>
      seedPerson(tag, { ...nothing, account: true, grant: true }, FAR_AGO);

    const mergeCase = Effect.fnUntraced(function* mergeCase(
      tag: string,
      into: string | null,
      from: string | null
    ) {
      const admin = yield* administrator(`${tag}a`);
      const survivor = yield* seedPerson(`${tag}s`, nothing, FAR_AGO);
      const merged = yield* seedPerson(`${tag}m`, nothing, FAR_AGO);
      yield* setKept(survivor.personId, into);
      yield* setKept(merged.personId, from);

      yield* mergeAs(admin.personId, survivor.personId, merged.personId);

      return {
        merged: yield* stateOf(merged.personId),
        survivor: yield* keptOf(survivor.personId),
      };
    });

    it.effect(
      "F4: a merge keeps the later of the two dates on the survivor, the survivor's own when the merged person has none, the merged person's when the survivor has none, and the tombstone holds none",
      () =>
        Effect.gen(function* merges() {
          const early = "2030-01-01T00:00:00.000Z";
          const late = "2032-01-01T00:00:00.000Z";

          const survivorLater = yield* mergeCase("mg1", late, early);
          const survivorEarlier = yield* mergeCase("mg2", early, late);
          const survivorNone = yield* mergeCase("mg3", null, early);
          const mergedNone = yield* mergeCase("mg4", late, null);
          const bothNone = yield* mergeCase("mg5", null, null);

          assert.strictEqual(survivorLater.survivor, late);
          assert.strictEqual(survivorEarlier.survivor, late);
          assert.strictEqual(survivorNone.survivor, early);
          assert.strictEqual(mergedNone.survivor, late);
          assert.isNull(bothNone.survivor);

          for (const { merged } of [
            survivorLater,
            survivorEarlier,
            survivorNone,
            mergedNone,
            bothNone,
          ]) {
            assert.isNull(merged.kept);
            assert.isTrue(merged.anonymised);
          }
        })
    );

    it.effect(
      "F5: the export holds the date, and an erasure clears it with the core",
      () =>
        Effect.gen(function* exportAndErase() {
          const person = yield* seedPerson("ex1", nothing, FAR_AGO);
          const id = person.personId;
          yield* setKept(id, "2031-01-01T00:00:00.000Z");

          const exported = yield* runAs(
            selfPrincipal(id),
            PersonalDataEndpoints.exportMyData({ personId: id })
          );

          const text = yield* encodeJson(exported.tables);

          assert.include(text, "last_admin_place_end");
          assert.include(text, "2031-01-01");

          yield* runAs(
            selfPrincipal(id),
            PersonalDataEndpoints.erasePerson({ personId: id })
          );

          assert.deepStrictEqual(yield* stateOf(id), {
            anonymised: true,
            kept: null,
            places: 0,
          });
        })
    );
  }
);
