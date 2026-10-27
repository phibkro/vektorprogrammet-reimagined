/**
 * Spec 0007b R4: what the nightly retention run does in each deployment. A run that changes rows (`Apply`) is allowed in
 * production only when every period that it applies is decided; while one is a proposal the run only counts
 * (`ReportOnly`). Local and preview hold fake data and always apply. The table has a row for every deployment and for
 * each approval that can hold production back, and its last row (every period decided) is the control of the rows that
 * report: the same deployment and the same rules, only the approval differs.
 */
import { assert, describe, it } from "@effect/vitest";
import { Catalog, retentionRules } from "@vektorprogrammet/domain";
import type {
  PersonalDataDeclaration,
  RetentionMode,
  RetentionRule,
} from "@vektorprogrammet/domain";
import { Array as Arr, Order } from "effect";

import { Deployment } from "../src/server/deployment";
import { retentionModeFor } from "../src/server/retentionMode";

type Approval = PersonalDataDeclaration.Approval;

type Period = PersonalDataDeclaration.Period;

const real = retentionRules(Catalog);

/** `rule` with its own period set to `approval`. */
const ownPeriod =
  (approval: Approval) =>
  (rule: RetentionRule): RetentionRule => ({
    ...rule,
    retention: {
      ...rule.retention,
      period: { ...rule.retention.period, approval },
    },
  });

/** `rule` with the longer period that a consent gives set to `approval`; a rule without one stays as it is. */
const longerPeriod =
  (approval: Approval) =>
  (rule: RetentionRule): RetentionRule =>
    rule.retention.longerWhile === undefined
      ? rule
      : {
          ...rule,
          retention: {
            ...rule.retention,
            longerWhile: {
              ...rule.retention.longerWhile,
              period: { ...rule.retention.longerWhile.period, approval },
            },
          },
        };

/** Every period that `rule` applies, set to `approval`. */
const approved =
  (approval: Approval) =>
  (rule: RetentionRule): RetentionRule =>
    longerPeriod(approval)(ownPeriod(approval)(rule));

/** The periods that the rules apply: each rule's own, and the longer one that a consent gives. */
const periodsOf = (rules: readonly RetentionRule[]) => ({
  longer: Arr.flatMap(rules, ({ retention }) =>
    retention.longerWhile === undefined ? [] : [retention.longerWhile.period]
  ),
  own: Arr.map(rules, ({ retention }) => retention.period),
});

const proposedCount = (periods: readonly Period[]): number =>
  Arr.filter(periods, ({ approval }) => approval === "proposed").length;

/** How many periods of each kind the rules leave as a proposal. */
const proposedIn = (rules: readonly RetentionRule[]) => ({
  longer: proposedCount(periodsOf(rules).longer),
  own: proposedCount(periodsOf(rules).own),
});

const allDecided = Arr.map(real, approved("decided"));

const allProposed = Arr.map(real, approved("proposed"));

/** Every period decided except the first rule's own. */
const oneProposed = Arr.map(allDecided, (rule, index) =>
  index === 0 ? ownPeriod("proposed")(rule) : rule
);

/** Every period decided except the longer one that a consent gives. */
const longerProposed = Arr.map(allDecided, longerPeriod("proposed"));

const CASES: readonly (readonly [
  Deployment,
  string,
  readonly RetentionRule[],
  RetentionMode,
])[] = [
  ["local", "every period proposed", allProposed, "Apply"],
  ["local", "every period decided", allDecided, "Apply"],
  ["preview", "every period proposed", allProposed, "Apply"],
  ["preview", "every period decided", allDecided, "Apply"],
  ["production", "every period proposed", allProposed, "ReportOnly"],
  [
    "production",
    "one period proposed, the rest decided",
    oneProposed,
    "ReportOnly",
  ],
  [
    "production",
    "only the longer period of a consent proposed, the rest decided",
    longerProposed,
    "ReportOnly",
  ],
  ["production", "every period decided", allDecided, "Apply"],
];

describe("spec 0007b R4: the retention run's mode follows the deployment and the approval of the periods", () => {
  it("the table has a row for every deployment", () => {
    assert.deepStrictEqual(
      Arr.sort(
        Arr.dedupe(Arr.map(CASES, ([deployment]) => deployment)),
        Order.String
      ),
      Arr.sort(Deployment.literals, Order.String)
    );
  });

  it("the rules of each row are what the row says, counted from the declared approvals and not from the gate", () => {
    const longer = periodsOf(real).longer.length;

    // The person core's `keepDetails` is a longer period: without one, the row that proposes only it would change nothing.
    assert.isAbove(longer, 0);

    assert.deepStrictEqual(proposedIn(allDecided), { longer: 0, own: 0 });
    assert.deepStrictEqual(proposedIn(allProposed), {
      longer,
      own: real.length,
    });
    assert.deepStrictEqual(proposedIn(oneProposed), { longer: 0, own: 1 });
    assert.deepStrictEqual(proposedIn(longerProposed), { longer, own: 0 });
  });

  for (const [deployment, approval, rules, mode] of CASES) {
    it(`${deployment}, ${approval}: ${mode}`, () => {
      assert.strictEqual(retentionModeFor(deployment, rules), mode);
    });
  }

  it("the rules default to the declared catalog: local and preview apply, and production follows the approvals that the catalog declares", () => {
    assert.strictEqual(retentionModeFor("local"), "Apply");
    assert.strictEqual(retentionModeFor("preview"), "Apply");

    assert.strictEqual(
      retentionModeFor("production"),
      retentionModeFor("production", real)
    );
  });
});
