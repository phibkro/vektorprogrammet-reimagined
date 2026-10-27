/**
 * Spec 0007b falsifier 2: the nightly retention run on real PostgreSQL. The first group is table-driven: for each rule
 * that the catalog declares, one row is built whose period starts at a known instant, and the run is made one second
 * inside the period (nothing changes) and one second outside it (the row is deleted or anonymised, and nothing else of
 * its own), and a second run at that instant changes nothing. A rule that the catalog gains has no builder until one is
 * written, and a test fails first. The negative controls build a store that leaves one rule out and show that the same
 * table-driven check fails for that rule, for every rule.
 */
import { assert, layer } from "@effect/vitest";
import {
  AggregateLocks,
  Catalog,
  PersonalDataStore,
  afterDuration,
  retentionRules,
  ruleId,
} from "@vektorprogrammet/domain";
import type { Counts, RetentionRule } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
  Record as Rec,
} from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import { Aggregates } from "../src/aggregate/aggregates.ts";
import { transactional } from "../src/index.ts";
import { personalDataRetention } from "../src/personalData/retention.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import {
  FAR_AHEAD,
  alsoChanges,
  builders,
  createdAt,
} from "./support/retentionBuilders.ts";
import { snapshot } from "./support/snapshot.ts";
import { world } from "./support/teamsWorld.ts";

const rules = retentionRules(Catalog);

/** Runs the program in a transaction and rolls it back, handing back what it returned. A failure of the SQL is a defect. */
const rolledBack = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  transactional(
    Effect.flatMap(Effect.orDie(program), (value) => Effect.fail(value))
  ).pipe(Effect.flip);

/** One run of the retention at `now`: the real store, or one that leaves rules out. */
type Run = (
  now: DateTime.Utc
) => Effect.Effect<Counts, never, PersonalDataStore | SqlClient>;

const realRun: Run = (now) =>
  transactional(PersonalDataStore.use((store) => store.expire(now))).pipe(
    Effect.orDie
  );

/** A record as one text with its keys in alphabetical order: two records agree when their texts do. */
const canonical = (record: Readonly<Record<string, number | string>>): string =>
  Arr.join(
    Arr.map(
      Arr.sort(
        Rec.toEntries(record),
        Order.mapInput(
          Order.String,
          ([key]: readonly [string, number | string]) => key
        )
      ),
      ([key, value]) => `${key}=${value}`
    ),
    ","
  );

/** The counts that are not zero, as one text. */
const changed = (counts: Counts): string =>
  canonical(Rec.filter(counts, (n) => n !== 0));

const nothingChanged = "";

/** The tables that a run at the end of a rule's period changes, with one row each: the rule's own and what goes with it. */
const expectedAtEnd = (rule: RetentionRule): Counts => {
  const withPerson =
    Predicate.isTagged(rule.retention.trigger, "LastActivityEnd") &&
    rule.table !== "person"
      ? ["person"]
      : [];

  return Rec.fromEntries(
    Arr.map(
      [
        rule.table,
        ...withPerson,
        ...Option.match(
          Arr.findFirst(
            Rec.toEntries(alsoChanges),
            ([id]) => id === ruleId(rule)
          ),
          { onNone: () => [], onSome: ([, tables]) => tables }
        ),
      ],
      (table) => [table, 1] as const
    )
  );
};

/**
 * The problems of one rule's lifecycle: what is wrong with the way a run treats a row one second inside its period, one
 * second outside it, and again. Empty when the rule is applied exactly as declared. The run is rolled back.
 */
const lifecycleProblems = (rule: RetentionRule, tag: string, run: Run) =>
  rolledBack(
    Effect.gen(function* lifecycle() {
      const name = ruleId(rule);

      const found = Arr.findFirst(
        Rec.toEntries(builders),
        ([id]) => id === name
      );

      if (Option.isNone(found)) {
        return [`${name} has no builder`];
      }

      const [, builder] = found.value;

      const arranged = yield* world(tag).pipe(Effect.orDie);
      yield* createdAt(arranged.person.id, FAR_AHEAD);

      const built = yield* builder({
        personId: arranged.person.id,
        positionId: arranged.memberPosition,
        tag,
        teamId: arranged.team.id,
      });

      const expiry = afterDuration(built.start, rule.retention.period.duration);
      const inside = DateTime.subtract(expiry, { seconds: 1 });
      const outside = DateTime.add(expiry, { seconds: 1 });

      const before = yield* snapshot;
      const insideCounts = yield* run(inside);
      const afterInside = yield* snapshot;
      const presentInside = yield* built.present;
      const outsideCounts = yield* run(outside);
      const presentOutside = yield* built.present;
      const afterOutside = yield* snapshot;
      const secondCounts = yield* run(outside);
      const afterSecond = yield* snapshot;

      return [
        ...(changed(insideCounts) === nothingChanged &&
        canonical(before) === canonical(afterInside)
          ? []
          : [
              `${name}: a run one second inside the period changed ${changed(insideCounts)}`,
            ]),
        ...(presentInside
          ? []
          : [`${name}: the row was gone one second inside its period`]),
        ...(presentOutside
          ? [`${name}: the row is still there one second outside its period`]
          : []),
        ...(changed(outsideCounts) === changed(expectedAtEnd(rule))
          ? []
          : [
              `${name}: the run at the end changed ${changed(outsideCounts)}, expected ${changed(expectedAtEnd(rule))}`,
            ]),
        ...(changed(secondCounts) === nothingChanged &&
        canonical(afterOutside) === canonical(afterSecond)
          ? []
          : [`${name}: a second run at the same instant changed something`]),
      ];
    })
  );

/** The rules that a store leaves out when it skips `rule`: the rule, and the rules of its parent table, whose cascade would hide the skip. */
const without = (rule: RetentionRule): readonly RetentionRule[] => {
  const parent = Predicate.isTagged(rule.key, "Via") ? rule.key.parent : null;

  return Arr.filter(
    rules,
    (other) => other !== rule && (parent === null || other.table !== parent)
  );
};

const skippingRun = Effect.fnUntraced(function* skippingRun(
  rule: RetentionRule
) {
  const aggregates = yield* Aggregates;
  const db = yield* Drizzle;
  const locks = yield* AggregateLocks;
  const store = personalDataRetention({ aggregates, db, locks }, without(rule));

  return (now: DateTime.Utc) =>
    transactional(store.expire(now)).pipe(Effect.orDie);
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b falsifier 2: retention, table-driven over the declared rules",
  (it) => {
    it.effect(
      "every declared rule has a builder, and every builder is a declared rule",
      () =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            Arr.sort(Arr.map(rules, ruleId), Order.String),
            Arr.sort(Rec.keys(builders), Order.String)
          );
        })
    );

    for (const [index, rule] of rules.entries()) {
      it.effect(
        `${ruleId(rule)}: nothing changes one second inside its period, the row is removed one second outside it, and a second run changes nothing`,
        () =>
          Effect.gen(function* oneRule() {
            assert.deepStrictEqual(
              yield* lifecycleProblems(rule, `rule${index}`, realRun),
              []
            );
          })
      );
    }

    for (const [index, rule] of rules.entries()) {
      it.effect(
        `negative control: a run that skips ${ruleId(rule)} fails its check, and only that one`,
        () =>
          Effect.gen(function* skipped() {
            const run = yield* skippingRun(rule);

            const problems = yield* lifecycleProblems(
              rule,
              `skip${index}`,
              run
            );

            assert.isTrue(
              Arr.some(problems, (problem) =>
                problem.includes("is still there one second outside")
              ),
              `skipping ${ruleId(rule)} went unnoticed: ${Arr.join(problems, "; ")}`
            );
          })
      );
    }
  }
);
