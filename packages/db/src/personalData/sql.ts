/**
 * The SQL of the personal data declarations (spec 0007b): each trigger, period and key of the catalog compiled to a
 * fragment. The names are the catalog's own (trusted constants, quoted as identifiers); the values are bound. Every
 * calendar sum is done in Europe/Oslo wall-clock time, as the domain's `addOsloCalendar` does, so the compiled
 * statements and the pure rules agree, and no session setting is involved (Hyperdrive).
 */
import { Catalog, PersonalDataDeclaration } from "@vektorprogrammet/domain";
import type { CatalogOf, RetentionRule } from "@vektorprogrammet/domain";
import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Option,
  Predicate,
  Record as Rec,
} from "effect";

const { Anonymised, Duration, PersonKey, Trigger } = PersonalDataDeclaration;

type Key = typeof PersonKey.Type;

type Span = typeof Duration.Type;

const catalog: CatalogOf = Catalog;

/** A table or column name, quoted. The names are the catalog's own, never a request's. */
export const identifier = (value: string) => sql.identifier(value);

/** `"table"."column"`. */
export const col = (table: string, column: string): SQL =>
  sql`${identifier(table)}.${identifier(column)}`;

/** All the conditions that are given; no condition at all is true. */
export const allOf = (...conditions: readonly (SQL | undefined)[]): SQL =>
  and(...conditions) ?? sql`true`;

/** A comma-separated list of bound values. */
const list = (values: readonly (number | string)[]): SQL =>
  sql.join(
    Arr.map(values, (value) => sql`${value}`),
    sql`, `
  );

/** `instant + duration` in Oslo wall-clock time. */
export const addDuration = (instant: SQL, duration: Span): SQL => {
  const interval = Duration.match(duration, {
    Days: ({ count }) => sql`make_interval(days => ${count}::int)`,
    Months: ({ count }) => sql`make_interval(months => ${count}::int)`,
    Years: ({ count }) => sql`make_interval(years => ${count}::int)`,
  });

  return sql`((${instant} at time zone 'Europe/Oslo') + ${interval}) at time zone 'Europe/Oslo'`;
};

/** The person a row of `table` belongs to, as an expression: the key column, or one hop through a parent. */
export const personOf = (table: string, key: Key): SQL =>
  PersonKey.match(key, {
    Address: () => sql`null`,
    Direct: ({ column }) => col(table, column),
    Via: ({ column, parent, parentKey }) => {
      const parentPerson = Rec.get(catalog, parent).pipe(
        Option.flatMapNullishOr((declaration) => declaration.person?.key)
      );

      return Option.isSome(parentPerson) &&
        Predicate.isTagged(parentPerson.value, "Direct")
        ? sql`(select ${col(parent, parentPerson.value.column)} from ${identifier(parent)} where ${col(parent, parentKey)} = ${col(table, column)})`
        : sql`null`;
    },
  });

/** The people whose rows are wanted: their ids, and their e-mail addresses for the tables that are keyed by address. */
export interface People {
  readonly ids: readonly number[];
  readonly addresses: readonly string[];
}

/** The rows of `table` that are about these people. */
export const aboutPeople = (table: string, key: Key, people: People): SQL =>
  PersonKey.match(key, {
    Address: ({ column, paths }) => {
      const values = Arr.isReadonlyArrayEmpty(paths)
        ? [col(table, column)]
        : Arr.map(
            paths,
            (path) => sql`${col(table, column)} ->> ${path}::text`
          );

      return Arr.isReadonlyArrayEmpty(people.addresses)
        ? sql`false`
        : sql`(${sql.join(
            Arr.map(
              values,
              (value) => sql`lower(${value}) in (${list(people.addresses)})`
            ),
            sql` or `
          )})`;
    },
    Direct: ({ column }) => sql`${col(table, column)} in (${list(people.ids)})`,
    Via: () => sql`${personOf(table, key)} in (${list(people.ids)})`,
  });

/** When a rule's period starts for a row of its table. */
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

/** The instant a row of the rule's table expires: its start plus the period, or the longer one while its consent is current. */
const expiresAt = (rule: RetentionRule): SQL => {
  const start = startOf(rule);
  const { longerWhile, period } = rule.retention;

  if (longerWhile === undefined || rule.key === null) {
    return addDuration(start, period.duration);
  }

  return sql`case when exists (select 1 from ${identifier("consent")} as ${identifier("c")} where ${col("c", "person_id")} = ${personOf(rule.table, rule.key)} and ${col("c", "kind")} = ${longerWhile.consent} and ${col("c", "withdrawn_at")} is null) then ${addDuration(start, longerWhile.period.duration)} else ${addDuration(start, period.duration)} end`;
};

/** Whether a row of the rule's table has reached the end of its period at `now`. */
export const expiredAt = (rule: RetentionRule, now: DateTime.Utc): SQL =>
  sql`${expiresAt(rule)} <= ${DateTime.toDateUtc(now)}`;

/** What an anonymised column holds: a bound value, or the row's id between a prefix and a suffix. */
export const anonymisedValue = (
  table: string,
  to: typeof Anonymised.Type
): SQL =>
  Anonymised.match(to, {
    Flag: ({ value }) => sql`${value}`,
    Null: () => sql`null`,
    PerRow: ({ prefix, suffix }) =>
      sql`${prefix}::text || ${col(table, "id")}::text || ${suffix}::text`,
    Text: ({ value }) => sql`${value}`,
  });
