/**
 * Spec 0021 falsifiers 2 and 4 (the domain half), and the worked cases of falsifier 1. The equality with PostgreSQL's arithmetic
 * is `packages/db/test/retentionOracle.postgres.test.ts`: the same functions, the same generators, the database as the
 * oracle. Here the domain is checked against itself: the ranges that an adapter filters by must say, of every start, what
 * the arithmetic says of its end, near the end of the period, which is where an off-by-one or a wrong zone changes the answer.
 */
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Array as Arr, DateTime, Effect, Option } from "effect";

import {
  afterDuration,
  dueWallRanges,
  fiscalYearDueBefore,
  inWallRanges,
  isAlumniCandidate,
  lastActivityDue,
  lastActivityEnd,
  retentionEnd,
  semesterDueYears,
  startIsDue,
} from "../../src/index.ts";
import type { ActivityFacts, WallRange } from "../../src/index.ts";
import { days, months, years } from "../../src/personalData/declaration.ts";
import { Periods } from "../../src/personalData/periods.ts";
import {
  fiscalYearEnd,
  semesterEnd,
} from "../../src/personalData/retentionEnd.ts";
import {
  around,
  atAClockChange,
  atTheBoundary,
  atTheEnd,
  inEffectsDefault,
} from "../support/retentionGenerators.ts";
import type { AtTheBoundary } from "../support/retentionGenerators.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant);

/** The instant of a whole Oslo-midnight date, for readable fixtures. */
const osloMidnight = (year: number, month: number, day: number) =>
  at(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+0${month >= 4 && month <= 10 ? 2 : 1}:00`
  );

describe("spec 0021 falsifier 1, worked cases: PostgreSQL's reading of the Oslo calendar", () => {
  // The expected values were read from PostgreSQL 17: ((s at time zone 'Europe/Oslo') + interval) at time zone 'Europe/Oslo'.
  it("a month later in the hour that repeats: 00:59Z ends at 01:59Z, and 01:00Z, a minute after, ends at 01:00Z", () => {
    assert.strictEqual(
      iso(afterDuration(at("2025-10-26T00:59:00Z"), months(1))),
      "2025-11-26T01:59:00.000Z"
    );
    assert.strictEqual(
      iso(afterDuration(at("2025-10-26T01:00:00Z"), months(1))),
      "2025-11-26T01:00:00.000Z"
    );
  });

  it("a wall-clock time that exists twice is the second one (standard time), as PostgreSQL reads it", () => {
    assert.strictEqual(
      iso(afterDuration(at("2025-09-26T00:30:00Z"), months(1))),
      "2025-10-26T01:30:00.000Z"
    );
  });

  it("a wall-clock time that does not exist moves forward by the gap: 02:30 on 31 March 2024 is 01:30Z", () => {
    assert.strictEqual(
      iso(afterDuration(at("2024-01-31T01:30:00Z"), months(2))),
      "2024-03-31T01:30:00.000Z"
    );
  });

  it("a month's end clamps, and 29 February plus a year is 28 February", () => {
    assert.strictEqual(
      iso(afterDuration(at("2025-01-30T23:00:00Z"), months(1))),
      "2025-02-27T23:00:00.000Z"
    );
    assert.strictEqual(
      iso(afterDuration(at("2024-02-28T23:00:00Z"), years(1))),
      "2025-02-27T23:00:00.000Z"
    );
    assert.strictEqual(
      iso(afterDuration(osloMidnight(2024, 2, 29), years(1))),
      iso(osloMidnight(2025, 2, 28))
    );
  });

  it("days follow the wall clock across a DST change: 30 days from midnight 1 October (summer time) is midnight 31 October (winter time)", () => {
    assert.strictEqual(
      iso(afterDuration(osloMidnight(2026, 10, 1), days(30))),
      "2026-10-30T23:00:00.000Z"
    );
  });
});

describe("spec 0021 R2: what each trigger starts a period at", () => {
  it("a semester ends at Oslo midnight of 1 August (Vår) or 1 January of the next year (Høst)", () => {
    assert.strictEqual(
      iso(semesterEnd({ term: "VAR", year: 2026 })),
      iso(osloMidnight(2026, 8, 1))
    );
    assert.strictEqual(
      iso(semesterEnd({ term: "HOST", year: 2026 })),
      iso(osloMidnight(2027, 1, 1))
    );
  });

  it("a fiscal year ends at Oslo midnight of 1 January after the date's Oslo year", () => {
    // 23:30Z on 31 December 2026 is already 2027 in Oslo.
    assert.strictEqual(
      iso(fiscalYearEnd(at("2026-12-31T23:30:00Z"))),
      iso(osloMidnight(2028, 1, 1))
    );
    assert.strictEqual(
      iso(fiscalYearEnd(at("2026-12-31T22:30:00Z"))),
      iso(osloMidnight(2027, 1, 1))
    );
  });

  const created = at("2020-05-05T10:00:00Z");

  const facts = (partial: Partial<ActivityFacts>): ActivityFacts => ({
    createdAt: created,
    keptPlaceEnd: Option.none(),
    memberships: [],
    placeUntils: [],
    ...partial,
  });

  it("a person's last activity ends at the later of their last membership and their last admin place, or at their creation", () => {
    assert.strictEqual(iso(lastActivityEnd(facts({}))), iso(created));
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            memberships: [
              { term: "VAR", year: 2022 },
              { term: "HOST", year: 2021 },
            ],
          })
        )
      ),
      iso(osloMidnight(2022, 8, 1))
    );
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            memberships: [{ term: "VAR", year: 2022 }],
            placeUntils: [at("2023-02-01T12:00:00Z")],
          })
        )
      ),
      "2023-02-01T12:00:00.000Z"
    );
  });

  it("a membership ends the activity even when the person was created after it (the view's coalesce, not a maximum with creation)", () => {
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            createdAt: at("2030-01-01T00:00:00Z"),
            memberships: [{ term: "VAR", year: 2022 }],
          })
        )
      ),
      iso(osloMidnight(2022, 8, 1))
    );
  });

  it("spec 0026 F3: a place that retention deleted still counts: its kept end is one of the ends, whether it is the latest or not", () => {
    const kept = at("2024-03-01T00:00:00Z");

    // Alone: it is the end (the creation is not).
    assert.strictEqual(
      iso(lastActivityEnd(facts({ keptPlaceEnd: Option.some(kept) }))),
      iso(kept)
    );

    // After the last membership's end: the kept end is the later.
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            keptPlaceEnd: Option.some(kept),
            memberships: [{ term: "VAR", year: 2022 }],
          })
        )
      ),
      iso(kept)
    );

    // Before it: the membership's end is.
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            keptPlaceEnd: Option.some(kept),
            memberships: [{ term: "HOST", year: 2025 }],
          })
        )
      ),
      iso(osloMidnight(2026, 1, 1))
    );

    // Beside a place that is still there: the later of the two.
    assert.strictEqual(
      iso(
        lastActivityEnd(
          facts({
            keptPlaceEnd: Option.some(kept),
            placeUntils: [at("2027-01-01T00:00:00Z")],
          })
        )
      ),
      "2027-01-01T00:00:00.000Z"
    );
  });

  it("the longer period applies while the consent is current, and only then", () => {
    const retention = {
      longerWhile: {
        consent: "keepDetails" as const,
        period: Periods.personCoreWithKeepDetails,
      },
      period: Periods.personCore,
    };

    const start = at("2022-08-01T00:00:00Z");

    assert.strictEqual(
      iso(retentionEnd(retention, start, false)),
      iso(afterDuration(start, years(1)))
    );
    assert.strictEqual(
      iso(retentionEnd(retention, start, true)),
      iso(afterDuration(start, years(5)))
    );
    assert.isFalse(
      lastActivityDue(
        facts({ memberships: [{ term: "VAR", year: 2022 }] }),
        retention,
        true,
        at("2024-01-01T00:00:00Z")
      )
    );
    assert.isTrue(
      lastActivityDue(
        facts({ memberships: [{ term: "VAR", year: 2022 }] }),
        retention,
        false,
        at("2024-01-01T00:00:00Z")
      )
    );
  });
});

describe("spec 0021 R5: who the alumni mail asks", () => {
  const memberships = [{ term: "VAR" as const, year: 2024 }];

  const facts: ActivityFacts = {
    createdAt: at("2020-01-01T00:00:00Z"),
    keptPlaceEnd: Option.none(),
    memberships,
    placeUntils: [],
  };

  const end = semesterEnd({ term: "VAR", year: 2024 });

  it("after they left, until a period of their core after the engagement ends, and not twice for the same end", () => {
    assert.isFalse(
      isAlumniCandidate(facts, [], DateTime.subtract(end, { seconds: 1 }))
    );
    assert.isTrue(isAlumniCandidate(facts, [], end));

    const lastDay = DateTime.subtract(
      afterDuration(end, Periods.personCore.duration),
      { seconds: 1 }
    );

    assert.isTrue(isAlumniCandidate(facts, [], lastDay));
    assert.isFalse(
      isAlumniCandidate(
        facts,
        [],
        afterDuration(end, Periods.personCore.duration)
      )
    );
    assert.isFalse(isAlumniCandidate(facts, [end], end));
    assert.isTrue(
      isAlumniCandidate(facts, [DateTime.subtract(end, { days: 1 })], end)
    );
  });

  it("an admin place that outlasts the membership keeps the question open as long as the place does", () => {
    const withPlace: ActivityFacts = {
      ...facts,
      placeUntils: [at("2030-01-01T00:00:00Z")],
    };

    assert.isTrue(isAlumniCandidate(withPlace, [], at("2030-06-01T00:00:00Z")));
  });
});

const readingIn = (ranges: readonly WallRange[], reading: number): boolean =>
  Arr.some(
    ranges,
    ({ from, to }) =>
      DateTime.toEpochMillis(from) <= reading &&
      reading < DateTime.toEpochMillis(to)
  );

/** Whether `decide` says, of each start near `start`, what the arithmetic says: the ranges are exact when it does. */
const agreesNear = (
  { duration, now, start }: AtTheBoundary,
  decide: (candidate: DateTime.Utc, ranges: readonly WallRange[]) => boolean,
  ended: (candidate: DateTime.Utc) => boolean
): boolean => {
  const ranges = dueWallRanges(now, duration);

  return Arr.every(
    around(start),
    (candidate) => decide(candidate, ranges) === ended(candidate)
  );
};

/** The ranges say, of each start near `start`, exactly what the arithmetic says. */
const exact = (boundary: AtTheBoundary): boolean =>
  agreesNear(
    boundary,
    (candidate, ranges) => inWallRanges(ranges, candidate),
    (candidate) => startIsDue(candidate, boundary.duration, boundary.now)
  );

/** The mistake of ranges that end a millisecond late: an off-by-one at the end of each. */
const endingLate = (boundary: AtTheBoundary): boolean =>
  agreesNear(
    boundary,
    (candidate, ranges) =>
      inWallRanges(
        Arr.map(ranges, ({ from, to }) => ({
          from,
          to: DateTime.add(to, { milliseconds: 1 }),
        })),
        candidate
      ),
    (candidate) => startIsDue(candidate, boundary.duration, boundary.now)
  );

/** The mistake of reading a start on the UTC clock instead of Oslo's. */
const readInUtc = (boundary: AtTheBoundary): boolean =>
  agreesNear(
    boundary,
    (candidate, ranges) => readingIn(ranges, DateTime.toEpochMillis(candidate)),
    (candidate) => startIsDue(candidate, boundary.duration, boundary.now)
  );

/** The mistake of the hour that repeats: the end read as Effect's default reads it, the first occurrence. */
const endedInEffectsDefault = (boundary: AtTheBoundary): boolean =>
  agreesNear(
    boundary,
    (candidate, ranges) => inWallRanges(ranges, candidate),
    (candidate) =>
      DateTime.isLessThanOrEqualTo(
        inEffectsDefault(candidate, boundary.duration),
        boundary.now
      )
  );

/** What a check of a property finds: it holds for every generated case, or a negative control finds a case where it fails. */
const checks = (
  outcome: "Falsified" | "Passed",
  name: string,
  arbitrary: Arbitrary.Arbitrary<AtTheBoundary>,
  property: (boundary: AtTheBoundary) => boolean
) => {
  it.effect(
    name,
    () =>
      Effect.gen(function* propertyIsChecked() {
        const result = yield* Arbitrary.checkEffect(arbitrary, property, {
          runs: 20_000,
        });

        assert.strictEqual(
          result._tag,
          outcome,
          Arbitrary.formatCheckFailure(result)
        );
      }),
    120_000
  );
};

const holds = (
  name: string,
  arbitrary: Arbitrary.Arbitrary<AtTheBoundary>,
  property: (boundary: AtTheBoundary) => boolean
) => {
  checks("Passed", name, arbitrary, property);
};

const falsified = (
  name: string,
  arbitrary: Arbitrary.Arbitrary<AtTheBoundary>,
  property: (boundary: AtTheBoundary) => boolean
) => {
  checks("Falsified", name, arbitrary, property);
};

describe("spec 0021 falsifier 2: the ranges that an adapter filters by are exactly the starts whose period has ended", () => {
  holds(
    "property: near the end of the period (three days either side, anchored on DST changes, month ends and 29 February), a start is in the ranges if and only if afterDuration puts its end at or before now",
    atTheBoundary,
    exact
  );

  holds(
    "property: at the millisecond the period ends, and the millisecond either side of it",
    atTheEnd,
    exact
  );

  falsified(
    "negative control: ranges that end a millisecond late (an off-by-one) are falsified at the end of the period",
    atTheEnd,
    endingLate
  );

  falsified(
    "negative control: a start read on the UTC clock instead of Oslo's is falsified (a time-zone mistake)",
    atTheEnd,
    readInUtc
  );

  holds(
    "property: within two and a half hours of a change of the clock, in spring (the hour that does not exist) and autumn (the hour that repeats)",
    atAClockChange,
    exact
  );

  falsified(
    "negative control: the end read with Effect's default for the hour that repeats (the first occurrence) is falsified at a change of the clock",
    atAClockChange,
    endedInEffectsDefault
  );

  it.effect(
    "property: the last due semester year is due, the next is not, and every earlier one is, for both terms",
    () =>
      Effect.gen(function* semesters() {
        const result = yield* Arbitrary.checkEffect(
          atTheBoundary,
          ({ duration, now }) => {
            const last = semesterDueYears(now, duration);

            return Arr.every(["VAR", "HOST"] as const, (term) => {
              const year = last[term];

              const due = (candidate: number) =>
                startIsDue(
                  semesterEnd({ term, year: candidate }),
                  duration,
                  now
                );

              return (
                due(year) && !due(year + 1) && due(year - 1) && due(year - 7)
              );
            });
          },
          { runs: 5000 }
        );

        assert.strictEqual(
          result._tag,
          "Passed",
          Arbitrary.formatCheckFailure(result)
        );
      }),
    120_000
  );

  it.effect(
    "property: the fiscal bound separates the dates whose fiscal year has ended from those whose has not",
    () =>
      Effect.gen(function* fiscal() {
        const result = yield* Arbitrary.checkEffect(
          atTheBoundary,
          ({ duration, now, start }) => {
            const before = fiscalYearDueBefore(now, duration);

            return (
              DateTime.isLessThan(start, before) ===
              startIsDue(fiscalYearEnd(start), duration, now)
            );
          },
          { runs: 5000 }
        );

        assert.strictEqual(
          result._tag,
          "Passed",
          Arbitrary.formatCheckFailure(result)
        );
      }),
    120_000
  );

  it("a period of no days ends the instant it starts: the ranges of now hold now's reading and nothing after it", () => {
    const now = at("2026-06-01T10:00:00Z");
    const ranges = dueWallRanges(now, days(0));

    assert.isTrue(inWallRanges(ranges, now));
    assert.isFalse(
      inWallRanges(ranges, DateTime.add(now, { milliseconds: 1 }))
    );
    assert.isTrue(startIsDue(now, days(0), now));
  });

  it("the ranges are few and sorted: at most a handful, whatever the period", () => {
    const ranges = dueWallRanges(at("2026-03-31T09:00:00Z"), months(6));

    assert.isAtMost(ranges.length, 12);

    for (const [index, range] of ranges.entries()) {
      assert.isTrue(DateTime.isLessThan(range.from, range.to));
      const next = ranges[index + 1];

      assert.isTrue(
        next === undefined || DateTime.isLessThan(range.to, next.from)
      );
    }
  });
});
