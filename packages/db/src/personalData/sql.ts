/**
 * The SQL of the personal data declarations (spec 0007b): each trigger, period and key of the catalog compiled to a
 * fragment. The names are the catalog's own (trusted constants, quoted as identifiers); the values are bound. No calendar
 * sum is done here (spec 0021): the domain computes the thresholds that a row's start is compared with (`retentionEnd.ts`),
 * and this file only compares, so no session setting is involved (Hyperdrive) and no second implementation of the calendar
 * exists.
 */
import {
  Catalog,
  PersonalDataDeclaration,
  dueWallRanges,
  fiscalYearDueBefore,
  semesterDueYears,
} from "@vektorprogrammet/domain";
import type {
  CatalogOf,
  RetentionRule,
  WallRange,
} from "@vektorprogrammet/domain";
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

/** The people (ids) of a condition on a person, as a list that is never empty: no people is no row. */
export const personIn = (column: SQL, ids: readonly number[]): SQL =>
  Arr.isReadonlyArrayNonEmpty(ids)
    ? sql`${column} in (${list(ids)})`
    : sql`false`;

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

/** An Oslo wall-clock reading as the text that PostgreSQL reads as a `timestamp`: the domain's reading, labelled UTC, without the label. */
const wallText = (reading: DateTime.Utc): string =>
  DateTime.formatIso(reading).slice(0, -1);

/**
 * Whether `instant` (an expression) lies, on the Oslo wall clock, inside one of the ranges that the domain computed
 * (`dueWallRanges`). The adapter compares; the calendar is the domain's.
 */
const inWallRanges = (instant: SQL, ranges: readonly WallRange[]): SQL =>
  Arr.isReadonlyArrayNonEmpty(ranges)
    ? sql`(${sql.join(
        Arr.map(
          ranges,
          ({ from, to }) =>
            sql`(${instant} at time zone 'Europe/Oslo' >= ${wallText(from)}::timestamp and ${instant} at time zone 'Europe/Oslo' < ${wallText(to)}::timestamp)`
        ),
        sql` or `
      )})`
    : sql`false`;

/** The people of the rule's rows whose last activity ended their period: decided by the domain from facts, not by a view. */
export type ActivityDue = (rule: RetentionRule) => SQL;

/** Whether a row of the rule's table is due at `now` for the `duration` that applies to it: the thresholds of the domain, as a condition on the row's columns. */
const startedBefore = (
  rule: RetentionRule,
  duration: Span,
  now: DateTime.Utc
): SQL =>
  Trigger.match(rule.retention.trigger, {
    Column: ({ column }) =>
      inWallRanges(col(rule.table, column), dueWallRanges(now, duration)),
    FiscalYearEnd: ({ column }) =>
      sql`${col(rule.table, column)} < ${DateTime.toDateUtc(fiscalYearDueBefore(now, duration))}`,
    // Decided per person from the person's facts (`activityDue`), never by a comparison of one column.
    LastActivityEnd: () => sql`false`,
    PeriodEnd: ({ column }) =>
      sql`${col(rule.table, column)} in (select ${col("admission_period", "id")} from ${identifier("admission_period")} where ${inWallRanges(col("admission_period", "ends_at"), dueWallRanges(now, duration))})`,
    SemesterEnd: ({ term, year }) => {
      const last = semesterDueYears(now, duration);

      return sql`((${col(rule.table, term)} = 'VAR' and ${col(rule.table, year)} <= ${last.VAR}) or (${col(rule.table, term)} = 'HOST' and ${col(rule.table, year)} <= ${last.HOST}))`;
    },
  });

/**
 * Whether a row of the rule's table has reached the end of its period at `now`: the row's start is before the domain's
 * thresholds for the period that applies to it (the longer one while its consent is current). A rule that starts at the
 * person's last activity is decided from the person's facts and is `activityDue`'s.
 */
export const expiredAt = (
  rule: RetentionRule,
  now: DateTime.Utc,
  activityDue: ActivityDue
): SQL => {
  const { longerWhile, period } = rule.retention;

  if (Predicate.isTagged(rule.retention.trigger, "LastActivityEnd")) {
    return activityDue(rule);
  }

  const base = startedBefore(rule, period.duration, now);

  if (longerWhile === undefined || rule.key === null) {
    return base;
  }

  return sql`case when exists (select 1 from ${identifier("consent")} as ${identifier("c")} where ${col("c", "person_id")} = ${personOf(rule.table, rule.key)} and ${col("c", "kind")} = ${longerWhile.consent} and ${col("c", "withdrawn_at")} is null) then ${startedBefore(rule, longerWhile.period.duration, now)} else ${base} end`;
};

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
