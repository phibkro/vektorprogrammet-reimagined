/**
 * Spec 0021, falsifiers 1, 3, 4 and 5: the domain's retention arithmetic against today's, which is PostgreSQL's. The oracle
 * is the original migration's function and view (`installOracle`) and the compiled SQL of the retention run and of the
 * alumni candidates as they were (`retentionOracle.ts`). Each property generates rows, periods, triggers and instants near
 * the places where month arithmetic breaks (the two DST changes of every year, month ends, 29 February), and each has a
 * negative control: the same property with one mistake in the code under test, which must be falsified.
 */

import { assert, layer } from "@effect/vitest";
import {
  Periods,
  PersonalDataDeclaration,
  afterDuration,
  lastActivityEnd,
} from "@vektorprogrammet/domain";
import type { RetentionRule } from "@vektorprogrammet/domain";
import {
  around,
  atAClockChange,
  atTheBoundary,
  atTheEnd,
  durations,
  inEffectsDefault,
  inUtc,
  instants,
  negated,
} from "@vektorprogrammet/domain/testing/retention";
import type { AtTheBoundary } from "@vektorprogrammet/domain/testing/retention";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Arbitrary, Array as Arr, DateTime, Effect, Schema } from "effect";

import {
  alumniCandidates,
  peopleDue,
  readPeople,
} from "../src/personalData/activity.ts";
import { expiredAt } from "../src/personalData/sql.ts";
import { person } from "../src/schema.ts";
import { Drizzle } from "./support/database.ts";
import {
  oracleAddDuration,
  oracleAlumniCandidates,
  oracleDatabase,
  oracleExpiredAt,
} from "./support/retentionOracle.ts";
import { world } from "./support/teamsWorld.ts";

const { Duration, Retention, keyed, period, starts } = PersonalDataDeclaration;

type Span = typeof Duration.Type;

const RUNS = 1000;
const TIMEOUT = 300_000;

const WORDS = { en: "the row was written", no: "raden ble skrevet" };

/** A run that no person's facts decide: the rules of the scratch table have no person. */
const nobody = (): SQL => sql`false`;

const at = (instant: DateTime.Utc): Date => DateTime.toDateUtc(instant);

const ms = (instant: DateTime.Utc): number => DateTime.toEpochMillis(instant);

const sameList = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length &&
  Arr.every(left, (value, index) => right[index] === value);

// ----------------------------------------------------------------- arithmetic

const Ends = Schema.Array(
  Schema.Struct({ ends: Schema.DateTimeUtcFromDate, i: Schema.Int })
);

/** PostgreSQL's end of the period of each start, as the retention run used to compute it. */
const databaseEnds = Effect.fnUntraced(function* databaseEnds(
  cases: readonly AtTheBoundary[]
) {
  const db = yield* Drizzle;

  const selects = Arr.map(
    cases,
    ({ duration, start }, index) =>
      sql`select ${index}::int as i, ${oracleAddDuration(sql`${at(start)}::timestamptz`, duration)} as ends`
  );

  return yield* db
    .execute(sql.join(selects, sql` union all `), "objects")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ends)), Effect.orDie);
});

/** Whether `arithmetic` gives, for every case of a batch, the end that the database gives. */
const sameEnds =
  (arithmetic: (start: DateTime.Utc, duration: Span) => DateTime.Utc) =>
  (cases: readonly AtTheBoundary[]) =>
    Effect.map(databaseEnds(cases), (rows) =>
      Arr.every(rows, ({ ends, i }) => {
        const found = cases[i];

        return (
          found !== undefined &&
          ms(arithmetic(found.start, found.duration)) === ms(ends)
        );
      })
    );

const batches = Arbitrary.array(atTheBoundary, {
  maxLength: 50,
  minLength: 50,
});

const clockChangeBatches = Arbitrary.array(atAClockChange, {
  maxLength: 50,
  minLength: 50,
});

layer(oracleDatabase, { excludeTestServices: true })(
  "spec 0021 falsifier 1: the domain's arithmetic is the database's",
  (it) => {
    /** `arithmetic` against the database over `batch`: it equals it for every case, or (a control) a case is found where it does not. */
    const against = (
      outcome: "Falsified" | "Passed",
      name: string,
      batch: Arbitrary.Arbitrary<readonly AtTheBoundary[]>,
      arithmetic: (start: DateTime.Utc, duration: Span) => DateTime.Utc,
      runs: number
    ) => {
      it.effect(
        name,
        () =>
          Effect.gen(function* arithmeticIsChecked() {
            const result = yield* Arbitrary.checkEffect(
              batch,
              sameEnds(arithmetic),
              { runs }
            );

            assert.strictEqual(
              result._tag,
              outcome,
              Arbitrary.formatCheckFailure(result)
            );
          }),
        TIMEOUT
      );
    };

    against(
      "Passed",
      `property: afterDuration equals ((s at time zone 'Europe/Oslo') + interval) at time zone 'Europe/Oslo' for ${RUNS * 50} generated starts and durations`,
      batches,
      afterDuration,
      RUNS
    );

    against(
      "Falsified",
      "negative control: the same arithmetic on UTC (a time-zone mistake) is falsified",
      batches,
      inUtc,
      RUNS
    );

    against(
      "Falsified",
      "negative control: one day too many (an off-by-one) is falsified",
      batches,
      (start, duration) =>
        DateTime.add(afterDuration(start, duration), { days: 1 }),
      20
    );

    against(
      "Passed",
      `property: the same, for ${RUNS * 50} ends within two and a half hours of a change of the clock`,
      clockChangeBatches,
      afterDuration,
      RUNS
    );

    against(
      "Falsified",
      "negative control: Effect's own reading of the hour that repeats (the first occurrence) is falsified at a change of the clock",
      clockChangeBatches,
      inEffectsDefault,
      RUNS
    );
  }
);

// ------------------------------------------------------------------ selection

/** A row of the scratch table that stands in for any table with an instant, a term and a year. */
interface Scratch {
  readonly at: DateTime.Utc;
  readonly periodId?: number | undefined;
  readonly personId?: number | undefined;
  readonly term: "HOST" | "VAR";
  readonly year: number;
}

/** A rule over the scratch table, the rows it holds and the instant of the run. */
interface Selection {
  readonly now: DateTime.Utc;
  readonly rows: readonly Scratch[];
  readonly rule: RetentionRule;
}

const scratchRule = (
  trigger: PersonalDataDeclaration.Trigger,
  duration: Span
): RetentionRule => ({
  anonymised: {},
  columns: ["at"],
  expiry: "Delete",
  key: null,
  marker: undefined,
  retention: Retention.make({ period: period(duration, "decided"), trigger }),
  table: "retention_scratch",
});

const Ids = Schema.Array(Schema.Struct({ id: Schema.Int }));

/** The ids that `statement` selects, in ascending order. */
const idsOf = Effect.fnUntraced(function* idsOf(statement: SQL) {
  const db = yield* Drizzle;

  return Arr.map(
    yield* db
      .execute(statement, "objects")
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)), Effect.orDie),
    ({ id }) => id
  );
});

/** The scratch table: an instant, a term and a year, and the id of an admission period and of a person for the triggers and rules that name them. */
const scratchTable = Effect.gen(function* scratchTable() {
  const db = yield* Drizzle;

  yield* Effect.orDie(
    db.execute(
      sql`create table retention_scratch (id serial primary key, at timestamptz not null, term semester_term not null, year integer not null, period_id integer, person_id integer)`,
      "objects"
    )
  );
});

/** Puts `rows` in the scratch table, and only them. */
const fill = Effect.fnUntraced(function* fill(rows: readonly Scratch[]) {
  const db = yield* Drizzle;
  yield* Effect.orDie(
    db.execute(sql`delete from retention_scratch`, "objects")
  );

  yield* Effect.orDie(
    db.execute(
      sql`insert into retention_scratch (at, term, year, period_id, person_id) values ${sql.join(
        Arr.map(
          rows,
          (row) =>
            sql`(${at(row.at)}, ${row.term}::semester_term, ${row.year}, ${row.periodId ?? null}, ${row.personId ?? null})`
        ),
        sql`, `
      )}`,
      "objects"
    )
  );
});

const columnRows = (start: DateTime.Utc): readonly Scratch[] =>
  Arr.map(around(start), (instant): Scratch => ({
    at: instant,
    term: "VAR",
    year: 2000,
  }));

const columnSelection = (boundary: AtTheBoundary): Selection => ({
  now: boundary.now,
  rows: columnRows(boundary.start),
  rule: scratchRule(starts.column("at", WORDS), boundary.duration),
});

const fiscalSelection = (boundary: AtTheBoundary): Selection => {
  // The fiscal year ends at an Oslo midnight of 1 January, so the rows lie around the turn of the year of the start.
  const turn = DateTime.makeUnsafe(
    Date.UTC(DateTime.getPartUtc(boundary.start, "year"), 0, 1)
  );

  return {
    now: boundary.now,
    rows: [...columnRows(turn), ...columnRows(boundary.start)],
    rule: scratchRule(starts.fiscalYearEnd("at"), boundary.duration),
  };
};

/** The rows of both terms around the year of the start, and `now` at the end of the period of that year's semester. */
const semesterSelection = (boundary: AtTheBoundary): Selection => {
  const year = DateTime.getPartUtc(boundary.start, "year");

  const term =
    DateTime.getPartUtc(boundary.start, "month") <= 7 ? "VAR" : "HOST";

  const semesterEnds = DateTime.makeUnsafe(
    term === "VAR" ? Date.UTC(year, 7, 1) : Date.UTC(year + 1, 0, 1)
  );

  const wobble =
    ms(boundary.now) - ms(afterDuration(boundary.start, boundary.duration));

  return {
    now: DateTime.makeUnsafe(
      ms(afterDuration(semesterEnds, boundary.duration)) + wobble
    ),
    rows: Arr.flatMap([year - 12, year - 1, year, year + 1], (candidate) =>
      Arr.map(["VAR", "HOST"] as const, (each): Scratch => ({
        at: boundary.start,
        term: each,
        year: candidate,
      }))
    ),
    rule: scratchRule(starts.semesterEnd("term", "year"), boundary.duration),
  };
};

/** Whether the clause that `clauseOf` builds selects, from the rows of the selection, what the oracle selects. */
const agrees =
  (clauseOf: (rule: RetentionRule, now: DateTime.Utc) => SQL) =>
  (made: Selection) =>
    Effect.gen(function* selectionAgrees() {
      yield* fill(made.rows);

      const expected = yield* idsOf(
        sql`select id from retention_scratch where ${oracleExpiredAt(made.rule, made.now)} order by id`
      );

      const found = yield* idsOf(
        sql`select id from retention_scratch where ${clauseOf(made.rule, made.now)} order by id`
      );

      return sameList(expected, found);
    });

/** What the retention run selects by. */
const real = (rule: RetentionRule, now: DateTime.Utc): SQL =>
  expiredAt(rule, now, nobody);

const columns = Arbitrary.map(atTheBoundary, columnSelection);
const columnsAtTheEnd = Arbitrary.map(atTheEnd, columnSelection);
const columnsAtAClockChange = Arbitrary.map(atAClockChange, columnSelection);
const fiscal = Arbitrary.map(atTheBoundary, fiscalSelection);
const semesters = Arbitrary.map(atTheBoundary, semesterSelection);
const semestersAtTheEnd = Arbitrary.map(atTheEnd, semesterSelection);

layer(oracleDatabase, { excludeTestServices: true })(
  "spec 0021 falsifier 3: the rows that the retention run selects are the rows that the oracle selects",
  (it) => {
    it.effect("set-up: a scratch table", () => scratchTable);

    const holds = (
      name: string,
      arbitrary: Arbitrary.Arbitrary<Selection>,
      runs: number
    ) => {
      it.effect(
        name,
        () =>
          Effect.gen(function* propertyHolds() {
            const result = yield* Arbitrary.checkEffect(
              arbitrary,
              agrees(real),
              { runs }
            );

            assert.strictEqual(
              result._tag,
              "Passed",
              Arbitrary.formatCheckFailure(result)
            );
          }),
        TIMEOUT
      );
    };

    const falsified = (
      name: string,
      arbitrary: Arbitrary.Arbitrary<Selection>,
      clauseOf: (rule: RetentionRule, now: DateTime.Utc) => SQL
    ) => {
      it.effect(
        name,
        () =>
          Effect.gen(function* controlFails() {
            const result = yield* Arbitrary.checkEffect(
              arbitrary,
              agrees(clauseOf),
              { runs: 1500 }
            );

            assert.strictEqual(result._tag, "Falsified");
          }),
        TIMEOUT
      );
    };

    holds(
      "property: a column trigger, a period of days, months or years, at any instant near the end of the period",
      columns,
      1500
    );

    holds(
      "property: a column trigger at the very millisecond that the period ends, and one either side",
      columnsAtTheEnd,
      1500
    );

    holds(
      "property: a column trigger within two and a half hours of a change of the clock, in spring and in autumn",
      columnsAtAClockChange,
      1500
    );

    holds(
      "property: a fiscal-year trigger, rows around the turn of the Oslo year",
      fiscal,
      1000
    );

    holds(
      "property: a semester trigger, rows of both terms in the years around the period's end",
      semesters,
      1000
    );

    holds(
      "property: a semester trigger at the very millisecond that the period ends, and one either side",
      semestersAtTheEnd,
      500
    );

    falsified(
      "negative control: the selection one millisecond early (an off-by-one) is falsified at the end of the period",
      columnsAtTheEnd,
      (rule, now) =>
        expiredAt(rule, DateTime.subtract(now, { milliseconds: 1 }), nobody)
    );

    falsified(
      "negative control: the selection an hour late (a time-zone mistake) is falsified",
      columns,
      (rule, now) => expiredAt(rule, DateTime.add(now, { hours: 1 }), nobody)
    );

    falsified(
      "negative control: month arithmetic reversed (`start <= now - period`) is falsified",
      columns,
      (rule, now) =>
        sql`at <= ${at(afterDuration(now, negated(rule.retention.period.duration)))}`
    );

    falsified(
      "negative control: the last due semester year one too early (an off-by-one in the year) is falsified",
      semesters,
      (rule, now) => {
        const year = DateTime.getPartUtc(now, "year");

        return sql`((term = 'VAR' and year <= ${year - 1}) or (term = 'HOST' and year <= ${year - 2}))`;
      }
    );
  }
);

// ------------------------------------------------------------------- people

/** What a generated person is made of. */
interface Generated {
  readonly anonymised: boolean;
  readonly consentWithdrawn: boolean;
  readonly createdAt: DateTime.Utc;
  readonly keepDetails: boolean;
  readonly memberships: readonly {
    readonly term: "HOST" | "VAR";
    readonly year: number;
  }[];
  readonly requestedAtEnd: boolean;
  readonly requestedElsewhere: boolean;
  readonly untils: readonly DateTime.Utc[];
}

const Person = Schema.Struct({
  anonymised: Schema.Boolean,
  consentWithdrawn: Schema.Boolean,
  keepDetails: Schema.Boolean,
  memberships: Schema.Array(
    Schema.Struct({
      term: Schema.Literals(["HOST", "VAR"]),
      year: Schema.Int.check(
        Schema.isBetween({ maximum: 2060, minimum: 2008 })
      ),
    })
  ).check(Schema.isMaxLength(3)),
  requestedAtEnd: Schema.Boolean,
  requestedElsewhere: Schema.Boolean,
});

const people = Arbitrary.array(
  Arbitrary.map(
    Arbitrary.all({
      createdAt: instants,
      person: Arbitrary.schema(Person),
      untils: Arbitrary.array(instants, { maxLength: 2 }),
    }),
    ({ createdAt, person: made, untils }): Generated => ({
      ...made,
      createdAt,
      untils,
    })
  ),
  { maxLength: 5, minLength: 2 }
);

/** What the people are attached to: a field of study, a position and a team. */
interface Anchor {
  readonly departmentId: number;
  readonly fieldOfStudyId: number;
  readonly positionId: number;
  readonly teamId: number;
}

const rounds = { next: 0 };

const semesterEnds = (made: Generated): readonly DateTime.Utc[] =>
  Arr.map(made.memberships, ({ term, year }) =>
    DateTime.makeUnsafe(
      term === "VAR" ? Date.UTC(year, 7, 1) : Date.UTC(year + 1, 0, 1)
    )
  );

const run = Effect.fnUntraced(function* run(statement: SQL) {
  const db = yield* Drizzle;

  return yield* Effect.orDie(db.execute(statement, "objects"));
});

/** The memberships, places, consent and requests of the person that was written with `id`. */
const writeFacts = Effect.fnUntraced(function* writeFacts(
  anchor: Anchor,
  id: number,
  made: Generated
) {
  yield* Effect.forEach(
    Arr.dedupeWith(
      made.memberships,
      (left, right) => left.term === right.term && left.year === right.year
    ),
    ({ term, year }) =>
      run(
        sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
          values (${term}::semester_term, ${year}, ${id}, ${anchor.positionId}, ${term}::semester_term, ${year}, ${anchor.teamId})`
      ),
    { discard: true }
  );

  yield* Effect.forEach(
    made.untils,
    (until) =>
      run(
        sql`insert into admin_grant (person_id, until) values (${id}, ${at(until)})`
      ),
    { discard: true }
  );

  if (made.keepDetails) {
    yield* run(
      sql`insert into consent (person_id, kind, given_at, text_version, withdrawn_at) values (${id}, 'keepDetails', ${at(made.createdAt)}, 1, ${made.consentWithdrawn ? at(made.createdAt) : null})`
    );
  }

  if (made.requestedAtEnd) {
    yield* run(
      sql`insert into alumni_request (person_id, engagement_end, requested_at)
        select ${id}, max(semester_end(end_term, end_year)), ${at(made.createdAt)} from membership where person_id = ${id}
        having count(*) > 0`
    );
  }

  if (made.requestedElsewhere) {
    yield* run(
      sql`insert into alumni_request (person_id, engagement_end, requested_at)
        values (${id}, ${at(made.createdAt)}, ${at(made.createdAt)}) on conflict do nothing`
    );
  }
});

/** Writes the people with their memberships, places, consents and requests; returns their ids in order. */
const writePeople = Effect.fnUntraced(function* writePeople(
  anchor: Anchor,
  generated: readonly Generated[]
) {
  const db = yield* Drizzle;
  rounds.next += 1;
  const round = rounds.next;

  return yield* Effect.forEach(generated, (made, index) =>
    Effect.gen(function* writeOne() {
      const [row] = yield* Effect.orDie(
        db
          .insert(person)
          .values({
            anonymisedAt: made.anonymised ? at(made.createdAt) : null,
            createdAt: at(made.createdAt),
            email: `oracle.${round}.${index}@example.org`,
            fieldOfStudyId: anchor.fieldOfStudyId,
            name: `Oracle ${round} ${index}`,
          })
          .returning({ id: person.id })
      );

      const id = row?.id ?? 0;
      yield* writeFacts(anchor, id, made);

      return id;
    })
  );
});

const activityOf = (made: Generated) => ({
  createdAt: made.createdAt,
  memberships: made.memberships,
  placeUntils: made.untils,
});

/** A millisecond before, at and after each of `instants`. */
const aroundEach = (
  moments: readonly DateTime.Utc[]
): readonly DateTime.Utc[] =>
  Arr.dedupe(
    Arr.flatMap(moments, (moment) =>
      Arr.map([-1, 0, 1], (milliseconds) =>
        DateTime.add(moment, { milliseconds })
      )
    )
  );

/** Where a person's period under either of the person core's periods ends. */
const decisive = (made: Generated): readonly DateTime.Utc[] => {
  const end = lastActivityEnd(activityOf(made));

  return aroundEach([
    end,
    afterDuration(end, Periods.personCore.duration),
    afterDuration(end, Periods.personCoreWithKeepDetails.duration),
  ]);
};

/** Where the alumni mail's answer about a person can change: each membership's end, and the end of the person core after the last activity. */
const alumniDecisive = (made: Generated): readonly DateTime.Utc[] =>
  aroundEach([
    ...semesterEnds(made),
    afterDuration(
      lastActivityEnd(activityOf(made)),
      Periods.personCore.duration
    ),
  ]);

/** A rule over `person` itself, as the person core is declared: the last activity, and a longer period while `keepDetails` is current. */
const personCore: RetentionRule = {
  anonymised: {},
  columns: ["name"],
  expiry: "Delete",
  key: keyed.direct("id"),
  marker: undefined,
  retention: Retention.make({
    longerWhile: {
      consent: "keepDetails",
      period: Periods.personCoreWithKeepDetails,
    },
    period: Periods.personCore,
    trigger: starts.lastActivityEnd,
  }),
  table: "person",
};

const LastEnds = Schema.Array(
  Schema.Struct({ at: Schema.DateTimeUtcFromDate, person_id: Schema.Int })
);

const inList = (ids: readonly number[]): SQL =>
  sql.join(
    Arr.map(ids, (id) => sql`${id}`),
    sql`, `
  );

const anchorOf = Effect.fnUntraced(function* anchorOf(tag: string) {
  const made = yield* world(tag);

  return {
    departmentId: made.department.id,
    fieldOfStudyId: made.fieldOfStudy.id,
    positionId: made.memberPosition,
    teamId: made.team.id,
  } satisfies Anchor;
});

layer(oracleDatabase, { excludeTestServices: true })(
  "spec 0021 falsifier 4: a person's last activity and the end of their period are the view's",
  (it) => {
    it.effect(
      "property: lastActivityEnd equals the view, and at every instant where a decision changes the people due are those that the oracle selects; forgetting the admin places is falsified",
      () =>
        Effect.gen(function* lastActivityIsTheViews() {
          const db = yield* Drizzle;
          const anchor = yield* anchorOf("oracle4");

          const check =
            (lastEndOf: (made: Generated) => DateTime.Utc) =>
            (generated: readonly Generated[]) =>
              Effect.gen(function* oneRound() {
                const ids = yield* writePeople(anchor, generated);

                const view = yield* db
                  .execute(
                    sql`select person_id, at from person_last_activity_end where person_id in (${inList(ids)}) order by person_id`,
                    "objects"
                  )
                  .pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(LastEnds)),
                    Effect.orDie
                  );

                const endsAgree = Arr.every(view, (row) => {
                  const made = generated[ids.indexOf(row.person_id)];

                  return (
                    made !== undefined && ms(lastEndOf(made)) === ms(row.at)
                  );
                });

                const facts = yield* readPeople(
                  db,
                  sql`p.id in (${inList(ids)})`
                );

                const same = yield* Effect.forEach(
                  Arr.flatMap(generated, decisive),
                  (now) =>
                    Effect.map(
                      idsOf(
                        sql`select id from person where id in (${inList(ids)}) and ${oracleExpiredAt(personCore, now)} order by id`
                      ),
                      (expected) =>
                        sameList(expected, peopleDue(facts, personCore, now))
                    )
                );

                return endsAgree && Arr.every(same, (each) => each);
              });

          const result = yield* Arbitrary.checkEffect(
            people,
            check((made) => lastActivityEnd(activityOf(made))),
            { runs: 300 }
          );

          assert.strictEqual(
            result._tag,
            "Passed",
            Arbitrary.formatCheckFailure(result)
          );

          const forgetsPlaces = yield* Arbitrary.checkEffect(
            people,
            check((made) =>
              lastActivityEnd({ ...activityOf(made), placeUntils: [] })
            ),
            { runs: 300 }
          );

          assert.strictEqual(forgetsPlaces._tag, "Falsified");
        }),
      TIMEOUT
    );
  }
);

const Candidates = Schema.Array(Schema.Struct({ person_id: Schema.Int }));

layer(oracleDatabase, { excludeTestServices: true })(
  "spec 0021 falsifier 5: the alumni candidates are the SQL's",
  (it) => {
    it.effect(
      "property: at every instant where a person's decision changes the people the mail asks are those the oracle asks; a millisecond early is falsified",
      () =>
        Effect.gen(function* alumniAreTheSqls() {
          const db = yield* Drizzle;
          const anchor = yield* anchorOf("oracle5");

          const oracle = (now: DateTime.Utc) =>
            db
              .execute(
                oracleAlumniCandidates(now, Periods.personCore.duration),
                "objects"
              )
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Candidates)),
                Effect.map((rows) =>
                  Arr.map(rows, ({ person_id }) => person_id)
                ),
                Effect.orDie
              );

          const agreeWhenShifted =
            (shift: number) => (generated: readonly Generated[]) =>
              Effect.gen(function* oneRound() {
                yield* writePeople(anchor, generated);

                const same = yield* Effect.forEach(
                  Arr.flatMap(generated, alumniDecisive),
                  (now) =>
                    Effect.zipWith(
                      oracle(now),
                      alumniCandidates(
                        db,
                        DateTime.add(now, { milliseconds: shift })
                      ),
                      sameList
                    )
                );

                return Arr.every(same, (each) => each);
              });

          const result = yield* Arbitrary.checkEffect(
            people,
            agreeWhenShifted(0),
            { runs: 100 }
          );

          assert.strictEqual(
            result._tag,
            "Passed",
            Arbitrary.formatCheckFailure(result)
          );

          const early = yield* Arbitrary.checkEffect(
            people,
            agreeWhenShifted(-1),
            { runs: 100 }
          );

          assert.strictEqual(early._tag, "Falsified");
        }),
      TIMEOUT
    );
  }
);

// ------------------------------------------- rules that name another table

/** Rows that name an admission period: one for each end of a period that falls around `boundary.start`. */
const periodEndAgrees =
  (
    anchor: Anchor,
    semesterId: number,
    clauseOf: (rule: RetentionRule, now: DateTime.Utc) => SQL
  ) =>
  (boundary: AtTheBoundary) =>
    Effect.gen(function* periodEndSelection() {
      yield* run(sql`delete from retention_scratch`);
      yield* run(sql`delete from admission_period`);

      const periodIds = yield* idsOf(
        sql`insert into admission_period (department_id, semester_id, starts_at, ends_at) values ${sql.join(
          Arr.map(
            around(boundary.start),
            (end) =>
              sql`(${anchor.departmentId}, ${semesterId}, ${at(DateTime.subtract(end, { days: 1 }))}, ${at(end)})`
          ),
          sql`, `
        )} returning id`
      );

      return yield* agrees(clauseOf)({
        now: boundary.now,
        rows: Arr.map(periodIds, (periodId): Scratch => ({
          at: boundary.start,
          periodId,
          term: "VAR",
          year: 2000,
        })),
        rule: scratchRule(starts.periodEnd("period_id"), boundary.duration),
      });
    });

/** The period that the boundary decides, and a second one: the longer applies to the rows of a person whose consent is current. */
interface Lengthened {
  readonly boundary: AtTheBoundary;
  readonly boundaryIsLonger: boolean;
  readonly other: Span;
}

const lengthened = Arbitrary.map(
  Arbitrary.all({
    boundary: atTheBoundary,
    boundaryIsLonger: Arbitrary.schema(Schema.Boolean),
    other: durations,
  }),
  ({ boundary, boundaryIsLonger, other }): Lengthened => ({
    boundary,
    boundaryIsLonger,
    other,
  })
);

/** A person with a current `keepDetails` consent, one with none, and one whose consent is withdrawn. */
interface Holders {
  readonly withConsent: number;
  readonly withdrawn: number;
  readonly without: number;
}

/** A rule over the scratch rows' `person_id`, with the longer period while `keepDetails` is current. */
const lengthenedRule = (short: Span, long: Span): RetentionRule => ({
  ...scratchRule(starts.column("at", WORDS), short),
  key: keyed.direct("person_id"),
  retention: Retention.make({
    longerWhile: { consent: "keepDetails", period: period(long, "decided") },
    period: period(short, "decided"),
    trigger: starts.column("at", WORDS),
  }),
});

const consentAgrees =
  (
    holders: Holders,
    clauseOf: (rule: RetentionRule, now: DateTime.Utc) => SQL
  ) =>
  ({ boundary, boundaryIsLonger, other }: Lengthened) =>
    agrees(clauseOf)({
      now: boundary.now,
      rows: Arr.flatMap(around(boundary.start), (instant) =>
        Arr.map(
          [holders.withConsent, holders.without, holders.withdrawn],
          (personId): Scratch => ({
            at: instant,
            personId,
            term: "VAR",
            year: 2000,
          })
        )
      ),
      rule: boundaryIsLonger
        ? lengthenedRule(other, boundary.duration)
        : lengthenedRule(boundary.duration, other),
    });

/** The rule's selection with its consent left out: the mistake of a run that ignores `longerWhile`. */
const withoutConsent = (rule: RetentionRule, now: DateTime.Utc): SQL =>
  expiredAt(
    {
      ...rule,
      retention: Retention.make({
        period: rule.retention.period,
        trigger: rule.retention.trigger,
      }),
    },
    now,
    nobody
  );

const holderOf = (
  keepDetails: boolean,
  consentWithdrawn: boolean
): Generated => ({
  anonymised: false,
  consentWithdrawn,
  createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
  keepDetails,
  memberships: [],
  requestedAtEnd: false,
  requestedElsewhere: false,
  untils: [],
});

layer(oracleDatabase, { excludeTestServices: true })(
  "spec 0021 falsifier 3, rules that name another table: an admission period's end, and a consent that lengthens the period",
  (it) => {
    it.effect("set-up: a scratch table", () => scratchTable);

    it.effect(
      "property: a period-end trigger selects the rows whose admission period ended, as the oracle does; an hour late is falsified",
      () =>
        Effect.gen(function* periodEnds() {
          const anchor = yield* anchorOf("oracle3a");

          const [semesterId = 0] = yield* idsOf(
            sql`insert into semester (term, year) values ('VAR', 1999) returning id`
          );

          const result = yield* Arbitrary.checkEffect(
            atTheBoundary,
            periodEndAgrees(anchor, semesterId, real),
            { runs: 300 }
          );

          assert.strictEqual(
            result._tag,
            "Passed",
            Arbitrary.formatCheckFailure(result)
          );

          const late = yield* Arbitrary.checkEffect(
            atTheBoundary,
            periodEndAgrees(anchor, semesterId, (rule, now) =>
              expiredAt(rule, DateTime.add(now, { hours: 1 }), nobody)
            ),
            { runs: 300 }
          );

          assert.strictEqual(late._tag, "Falsified");
        }),
      TIMEOUT
    );

    it.effect(
      "property: a current consent lengthens the period of its holder's rows, a withdrawn one or none does not; ignoring the consent is falsified",
      () =>
        Effect.gen(function* consentLengthens() {
          const anchor = yield* anchorOf("oracle3b");

          const [withConsent = 0, without = 0, withdrawn = 0] =
            yield* writePeople(anchor, [
              holderOf(true, false),
              holderOf(false, false),
              holderOf(true, true),
            ]);

          const holders = { withConsent, withdrawn, without };

          const result = yield* Arbitrary.checkEffect(
            lengthened,
            consentAgrees(holders, real),
            { runs: 500 }
          );

          assert.strictEqual(
            result._tag,
            "Passed",
            Arbitrary.formatCheckFailure(result)
          );

          const ignoresIt = yield* Arbitrary.checkEffect(
            lengthened,
            consentAgrees(holders, withoutConsent),
            { runs: 500 }
          );

          assert.strictEqual(ignoresIt._tag, "Falsified");
        }),
      TIMEOUT
    );
  }
);
