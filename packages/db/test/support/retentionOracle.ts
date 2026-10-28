/**
 * Today's retention arithmetic, kept as the oracle of spec 0021: PostgreSQL's own. Production no longer reads any of it
 * (the domain's `retentionEnd` and the thresholds that it computes took its place), and a migration drops the function
 * `semester_end` and the view `person_last_activity_end`. The oracle is therefore not a copy of them that could drift:
 * `installOracle` re-runs the statements of the migration that created them, and the expressions below are the compiled
 * SQL of `packages/db/src/personalData/sql.ts` and of `AlumniRequests.candidates` as they were at `ddb6ff1`, moved here
 * unchanged apart from names.
 */
import { NodeServices } from "@effect/platform-node";
import { PersonalDataDeclaration } from "@vektorprogrammet/domain";
import type { RetentionRule } from "@vektorprogrammet/domain";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { DateTime, Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { col, identifier, personOf } from "../../src/personalData/sql.ts";
import { postgresDatabase } from "./database.ts";

const { Duration, Trigger } = PersonalDataDeclaration;

const original = new URL(
  "../../drizzle/20261027111351_person_last_activity_end/migration.sql",
  import.meta.url
).pathname;

/** Creates `semester_end` and `person_last_activity_end` again: the statements of the migration that made them. */
const installOracle = Effect.gen(function* installOracle() {
  const client = yield* SqlClient;
  const file = yield* (yield* FileSystem.FileSystem).readFileString(original);

  yield* Effect.forEach(
    file.split("--> statement-breakpoint"),
    (statement) => client.unsafe(statement),
    { discard: true }
  );
});

/**
 * A migrated disposable database with the oracle installed, and the Node services that the migration's file needs: the
 * layer of every test that compares the domain with it.
 */
export const oracleDatabase = Layer.effectDiscard(installOracle).pipe(
  Layer.provideMerge(Layer.merge(postgresDatabase(), NodeServices.layer))
);

/** `instant + duration` in Oslo wall-clock time, by PostgreSQL. */
export const oracleAddDuration = (
  instant: SQL,
  duration: typeof Duration.Type
): SQL => {
  const interval = Duration.match(duration, {
    Days: ({ count }) => sql`make_interval(days => ${count}::int)`,
    Months: ({ count }) => sql`make_interval(months => ${count}::int)`,
    Years: ({ count }) => sql`make_interval(years => ${count}::int)`,
  });

  return sql`((${instant} at time zone 'Europe/Oslo') + ${interval}) at time zone 'Europe/Oslo'`;
};

const startOf = (rule: RetentionRule): SQL =>
  Trigger.match(rule.retention.trigger, {
    Column: ({ column }) => col(rule.table, column),
    FiscalYearEnd: ({ column }) =>
      sql`make_timestamptz(extract(year from ${col(rule.table, column)} at time zone 'Europe/Oslo')::int + 1, 1, 1, 0, 0, 0, 'Europe/Oslo')`,
    LastActivityEnd: () =>
      sql`(select ${col("a", "at")} from ${identifier("person_last_activity_end")} as ${identifier("a")} where ${col("a", "person_id")} = ${rule.key === null ? sql`null` : personOf(rule.table, rule.key)})`,
    PeriodEnd: ({ column }) =>
      sql`(select ${col("ap", "ends_at")} from ${identifier("admission_period")} as ${identifier("ap")} where ${col("ap", "id")} = ${col(rule.table, column)})`,
    SemesterEnd: ({ term, year }) =>
      sql`${identifier("semester_end")}(${col(rule.table, term)}, ${col(rule.table, year)})`,
  });

const expiresAt = (rule: RetentionRule): SQL => {
  const start = startOf(rule);
  const { longerWhile, period } = rule.retention;

  if (longerWhile === undefined || rule.key === null) {
    return oracleAddDuration(start, period.duration);
  }

  return sql`case when exists (select 1 from ${identifier("consent")} as ${identifier("c")} where ${col("c", "person_id")} = ${personOf(rule.table, rule.key)} and ${col("c", "kind")} = ${longerWhile.consent} and ${col("c", "withdrawn_at")} is null) then ${oracleAddDuration(start, longerWhile.period.duration)} else ${oracleAddDuration(start, period.duration)} end`;
};

/** Whether a row of the rule's table has reached the end of its period at `now`, by PostgreSQL. */
export const oracleExpiredAt = (rule: RetentionRule, now: DateTime.Utc): SQL =>
  sql`${expiresAt(rule)} <= ${DateTime.toDateUtc(now)}`;

/** The people whom the alumni mail asked at `now`, by PostgreSQL: `AlumniRequests.candidates` as it was, in ascending id order. */
export const oracleAlumniCandidates = (
  now: DateTime.Utc,
  personCore: typeof Duration.Type
): SQL => {
  const at = DateTime.toDateUtc(now);

  return sql`select m.person_id
    from (
      select person_id, max(semester_end(end_term, end_year)) as last_end
      from membership
      group by person_id
    ) as m
    join person as p on p.id = m.person_id
    join person_last_activity_end as a on a.person_id = p.id
    where p.anonymised_at is null
      and p.merged_into is null
      and m.last_end <= ${at}
      and ${oracleAddDuration(sql`a.at`, personCore)} > ${at}
      and not exists (
        select 1 from alumni_request as r
        where r.person_id = m.person_id and r.engagement_end = m.last_end
      )
    order by m.person_id`;
};
