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
  retentionRules,
  ruleId,
} from "@vektorprogrammet/domain";
import type {
  Counts,
  RetentionRule,
  RetentionRun,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  Option,
  Order,
  Predicate,
  Record as Rec,
  String as Str,
} from "effect";
import type { DateTime } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import { Aggregates } from "../src/aggregate/aggregates.ts";
import { transactional } from "../src/index.ts";
import {
  personalDataRetention,
  personalDataRetentionReport,
} from "../src/personalData/retention.ts";
import { Drizzle, postgresJobDatabase } from "./support/database.ts";
import { alsoChanges, builders } from "./support/retentionBuilders.ts";
import { checkRule } from "./support/retentionRule.ts";
import type { Arranged } from "./support/retentionRule.ts";
import { nightlyCounts } from "./support/retentionRun.ts";
import { snapshot } from "./support/snapshot.ts";

const rules = retentionRules(Catalog);

/** Runs the program in a transaction and rolls it back, handing back what it returned. A failure of the SQL is a defect. */
const rolledBack = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  transactional(
    Effect.flatMap(Effect.orDie(program), (value) => Effect.fail(value))
  ).pipe(Effect.flip);

/** One run of the retention at `now`: the real run of the layer, or a store that leaves rules out. */
type Run = (
  now: DateTime.Utc
) => Effect.Effect<Counts, never, RetentionRun | SqlClient>;

const realRun: Run = (now) =>
  transactional(nightlyCounts(now)).pipe(Effect.orDie);

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
    checkRule(
      rule,
      tag,
      Effect.fnUntraced(function* lifecycle(
        name: string,
        { built, inside, outside }: Arranged
      ) {
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
    )
  );

/** The report: the run that only counts, over the layer's database handle, as one `Run`. */
const reportRun = Effect.gen(function* reportRun() {
  const { expire } = personalDataRetentionReport(yield* Drizzle);

  return (now: DateTime.Utc) => transactional(expire(now)).pipe(Effect.orDie);
});

/**
 * The problems of a report of one rule (spec 0007b R4): the run that only counts, one second inside the period and one
 * second outside it. Empty when the report counts nothing inside it and, outside it, what a run changes (the rule's
 * row and what goes with it), changes no row of any table, and the run that changes rows then changes exactly what the
 * report counted. The run is rolled back.
 */
const reportProblems = (rule: RetentionRule, tag: string, report: Run) =>
  rolledBack(
    checkRule(
      rule,
      tag,
      Effect.fnUntraced(function* reported(
        name: string,
        { built, inside, outside }: Arranged
      ) {
        const before = yield* snapshot;
        const insideCounts = yield* report(inside);
        const outsideCounts = yield* report(outside);
        const afterReports = yield* snapshot;
        const present = yield* built.present;
        const applied = yield* realRun(outside);

        return [
          ...(changed(insideCounts) === nothingChanged
            ? []
            : [
                `${name}: a report one second inside the period counted ${changed(insideCounts)}`,
              ]),
          ...(changed(outsideCounts) === changed(expectedAtEnd(rule))
            ? []
            : [
                `${name}: the report at the end counted ${changed(outsideCounts)}, expected ${changed(expectedAtEnd(rule))}`,
              ]),
          ...(canonical(before) === canonical(afterReports) && present
            ? []
            : [`${name}: a report changed something`]),
          ...(changed(applied) === changed(outsideCounts)
            ? []
            : [
                `${name}: the run that changes rows changed ${changed(applied)}, the report had counted ${changed(outsideCounts)}`,
              ]),
        ];
      })
    )
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

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
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
                Str.includes("is still there one second outside")(problem)
              ),
              `skipping ${ruleId(rule)} went unnoticed: ${Arr.join(problems, "; ")}`
            );
          })
      );
    }

    // The report (spec 0007b R4): the same selections, counted. For every rule it counts nothing one second inside the
    // period and what a run changes one second outside it, changes no row of any table, and the run that changes rows
    // then changes exactly what it counted.
    for (const [index, rule] of rules.entries()) {
      it.effect(
        `${ruleId(rule)}: a report counts what the run changes, changes nothing, and the run that changes rows then changes exactly that`,
        () =>
          Effect.gen(function* oneReport() {
            assert.deepStrictEqual(
              yield* reportProblems(rule, `report${index}`, yield* reportRun),
              []
            );
          })
      );
    }

    for (const [index, rule] of rules.entries()) {
      it.effect(
        `negative control: a "report" that changes rows fails its check for ${ruleId(rule)}`,
        () =>
          Effect.gen(function* changesRows() {
            const problems = yield* reportProblems(
              rule,
              `reportctl${index}`,
              realRun
            );

            assert.isTrue(
              Arr.some(problems, (problem) =>
                Str.includes("a report changed something")(problem)
              ),
              `a report that changes ${ruleId(rule)} went unnoticed: ${Arr.join(problems, "; ")}`
            );
          })
      );
    }
  }
);
