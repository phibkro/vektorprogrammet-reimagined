/**
 * The merge of two people (spec 0007b), run from the catalog: every column that refers to a person has a merge rule,
 * and the rule says what happens to the merged person's rows. Both people are locked by the caller (and the admin list
 * before them), so every statement here runs under the tokens, and a table that a person owns is written only through
 * `Aggregates`. A constraint that refuses a moved row (two memberships that overlap in one team) is a `Conflict` with
 * the text that the rule declares, and the caller's transaction rolls back, so a refused merge changes nothing.
 */
import {
  Catalog,
  Conflict,
  PersonalDataDeclaration,
  keptDates,
  personReferences,
} from "@vektorprogrammet/domain";
import type {
  CatalogOf,
  Locked,
  PersonReference,
} from "@vektorprogrammet/domain";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Record as Rec,
} from "effect";

import type { Aggregates, QueryFailure } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import type { Root } from "../aggregate/model.ts";
import { isConstraintViolation } from "../classifySqlFailure.ts";
import type { Drizzle } from "../internal/drizzle.ts";
import { noCounts, tally } from "./counts.ts";
import { allOf, col, identifier } from "./sql.ts";
import { ownedBy, propertyOf, tableOf } from "./tables.ts";

const { MERGE_REFUSED, MergeRule } = PersonalDataDeclaration;

type Person = Locked<"Person">;

type Rule = typeof MergeRule.Type;

const catalog: CatalogOf = Catalog;
const personRoot: Root<"Person"> = roots.Person;

const ANONYMISED = "En av personene er anonymisert og kan ikke slås sammen.";

/** The references in a stable order: by table, then column. */
const references = Arr.sort(
  personReferences(catalog),
  Order.combine(
    Order.mapInput(
      Order.String,
      (reference: PersonReference) => reference.table
    ),
    Order.mapInput(
      Order.String,
      (reference: PersonReference) => reference.column
    )
  )
);

/** The rows of `table` that belong to one person: `column` is the column that refers to them. */
const rowOfPerson = (table: string, column: string, person: number): SQL =>
  sql`${col(table, column)} = ${person}`;

/** A row of `table` for which the survivor has a row that agrees on every one of `columns`. */
const collidesWith = (
  table: string,
  column: string,
  columns: readonly string[],
  survivor: number
): SQL =>
  sql`exists (select 1 from ${identifier(table)} as ${identifier("other")} where ${col("other", column)} = ${survivor} and ${sql.join(
    Arr.map(
      columns,
      (same) => sql`${col("other", same)} = ${col(table, same)}`
    ),
    sql` and `
  )})`;

/** Every row of `table`, when the survivor has a row of their own. */
const survivorHasRow = (table: string, column: string, survivor: number): SQL =>
  sql`exists (select 1 from ${identifier(table)} as ${identifier("other")} where ${col("other", column)} = ${survivor})`;

/** A row of `table` for which `other` has a row of the same `by` that is `later` or `earlier` than it by `at`. */
const supersededBy = (
  table: string,
  column: string,
  by: string,
  at: string,
  other: number,
  order: "earlier" | "later"
): SQL =>
  sql`exists (select 1 from ${identifier(table)} as ${identifier("other")} where ${col("other", column)} = ${other} and ${col("other", by)} = ${col(table, by)} and ${col("other", at)} ${order === "later" ? sql`>` : sql`<`} ${col(table, at)})`;

const conflict = (into: Person, from: Person, message: string) =>
  new Conflict({
    entity: "Person",
    key: `${into.id}:${from.id}`,
    message,
  });

/** A refusal by the database is the rule's text; any other failure is a defect. */
const asRefusal = (
  error: QueryFailure,
  into: Person,
  from: Person,
  message: string
) =>
  isConstraintViolation(error)
    ? Effect.fail(conflict(into, from, message))
    : Effect.die(error);

export const personalDataMerge = (services: {
  readonly aggregates: Aggregates["Service"];
  readonly anonymisePerson: (
    locked: Person,
    now: DateTime.Utc
  ) => Effect.Effect<number>;
  readonly db: Drizzle["Service"];
}) => {
  const { aggregates, anonymisePerson, db } = services;

  /** A table that a person owns is written through the owner's column only: the rule must name that column. */
  const ownedOn = Effect.fnUntraced(function* ownedOn(
    table: string,
    column: string
  ) {
    const handle = ownedBy(table);

    if (Option.isNone(handle)) {
      return handle;
    }

    const tableDefinition = yield* tableOf(table);

    return propertyOf(tableDefinition, column) === handle.value.ownerKey
      ? handle
      : yield* Effect.die(
          `${table}.${column} refers to a person in a table that a person owns, but it is not the owner column`
        );
  });

  const deleteRows = Effect.fnUntraced(function* deleteRows(
    table: string,
    column: string,
    owner: Person,
    where?: SQL
  ) {
    const handle = yield* ownedOn(table, column);

    if (Option.isSome(handle)) {
      const rows = yield* aggregates
        .remove(owner, handle.value, where)
        .pipe(Effect.orDie);

      return rows.length;
    }

    const definition = yield* tableOf(table);

    const rows = yield* db
      .delete(definition)
      .where(allOf(rowOfPerson(table, column, owner.id), where))
      .returning({ one: sql`1` })
      .pipe(Effect.orDie);

    return rows.length;
  });

  /** The merged person's rows become the survivor's: through `reassign` when a person owns the table. */
  const moveRows = Effect.fnUntraced(function* moveRows(
    table: string,
    column: string,
    into: Person,
    from: Person,
    refusal: string
  ) {
    const handle = yield* ownedOn(table, column);

    if (Option.isSome(handle)) {
      const rows = yield* aggregates
        .reassign(from, into, handle.value)
        .pipe(Effect.catch((error) => asRefusal(error, into, from, refusal)));

      return rows.length;
    }

    const definition = yield* tableOf(table);

    const rows = yield* db
      .update(definition)
      .set({ [propertyOf(definition, column)]: into.id })
      .where(rowOfPerson(table, column, from.id))
      .returning({ one: sql`1` })
      .pipe(Effect.catch((error) => asRefusal(error, into, from, refusal)));

    return rows.length;
  });

  const hasRowsOfBoth = (
    table: string,
    column: string,
    into: Person,
    from: Person
  ): Effect.Effect<boolean> =>
    db
      .execute<{ have_both: boolean }>(
        sql`select exists (select 1 from ${identifier(table)} where ${rowOfPerson(table, column, from.id)}) and exists (select 1 from ${identifier(table)} where ${rowOfPerson(table, column, into.id)}) as have_both`,
        "objects"
      )
      .pipe(
        Effect.map(([row]) => row?.have_both === true),
        Effect.orDie
      );

  /**
   * One row per `by` is left: the survivor's row goes when the merged person has one for the same `by` that is `later`
   * or `earlier` by `at`, and the merged person's goes when the survivor has one that is not (a tie keeps the
   * survivor's); what is left of the merged person's moves.
   */
  const keepOnePer = Effect.fnUntraced(function* keepOnePer(
    table: string,
    column: string,
    into: Person,
    from: Person,
    by: string,
    at: string,
    order: "earlier" | "later"
  ) {
    const replaced = yield* deleteRows(
      table,
      column,
      into,
      supersededBy(table, column, by, at, from.id, order)
    );

    const covered = yield* deleteRows(
      table,
      column,
      from,
      collidesWith(table, column, [by], into.id)
    );

    return (
      replaced +
      covered +
      (yield* moveRows(table, column, into, from, MERGE_REFUSED))
    );
  });

  const mergeRows = (
    rule: Rule,
    table: string,
    column: string,
    into: Person,
    from: Person
  ): Effect.Effect<number, Conflict> =>
    MergeRule.match(rule, {
      Drop: () => deleteRows(table, column, from),
      Earliest: ({ by, madeAt }) =>
        keepOnePer(table, column, into, from, by, madeAt, "earlier"),
      Follow: () => moveRows(table, column, into, from, MERGE_REFUSED),
      Inherit: () =>
        Effect.gen(function* inheritOnce() {
          // One row per person: the merged person's row goes when the survivor has one, and moves when not.
          const covered = yield* deleteRows(
            table,
            column,
            from,
            survivorHasRow(table, column, into.id)
          );

          return (
            covered +
            (yield* moveRows(table, column, into, from, MERGE_REFUSED))
          );
        }),
      Move: ({ collisions, refusal }) =>
        Effect.gen(function* moveWithCollisions() {
          const dropped = Arr.isReadonlyArrayNonEmpty(collisions)
            ? yield* deleteRows(
                table,
                column,
                from,
                collidesWith(table, column, collisions, into.id)
              )
            : 0;

          return (
            dropped + (yield* moveRows(table, column, into, from, refusal))
          );
        }),
      Newest: ({ by, decidedAt }) =>
        keepOnePer(table, column, into, from, by, decidedAt, "later"),
      Single: ({ message }) =>
        Effect.gen(function* atMostOne() {
          if (yield* hasRowsOfBoth(table, column, into, from)) {
            return yield* conflict(into, from, message);
          }

          return yield* moveRows(table, column, into, from, message);
        }),
      Stay: () => Effect.succeed(0),
    });

  /** Whether either person was anonymised already: a record with no data cannot be merged into or from. */
  const anyAnonymised = (into: Person, from: Person): Effect.Effect<boolean> =>
    db
      .execute<{ anonymised: boolean }>(
        sql`select exists (select 1 from person where id in (${into.id}, ${from.id}) and anonymised_at is not null) as anonymised`,
        "objects"
      )
      .pipe(
        Effect.map(([row]) => row?.anonymised === true),
        Effect.orDie
      );

  /**
   * The date that a table's retention keeps on the person (spec 0026) goes to the survivor as the later of the two, before
   * the merged person is anonymised and the tombstone's copy is cleared.
   */
  const foldKeptDates = Effect.fnUntraced(function* foldKeptDates(
    into: Person,
    from: Person
  ) {
    const person = yield* tableOf("person");

    yield* Effect.forEach(
      Arr.dedupe(Arr.map(keptDates(catalog), ({ into: column }) => column)),
      (column) =>
        aggregates
          .updateRoot(
            into,
            personRoot,
            Rec.fromEntries([
              [
                propertyOf(person, column),
                sql`greatest(${col("person", column)}, (select ${col("merged", column)} from person as merged where ${col("merged", "id")} = ${from.id}))`,
              ] as const,
            ])
          )
          .pipe(Effect.orDie)
    );
  });

  const merge = Effect.fn("PersonalDataStore.merge")(function* merge(
    into: Person,
    from: Person
  ) {
    if (yield* anyAnonymised(into, from)) {
      return yield* conflict(into, from, ANONYMISED);
    }

    const written = yield* Effect.forEach(
      references,
      ({ column, rule, table }) =>
        Effect.map(
          mergeRows(rule, table, column, into, from),
          (rows) => [table, rows] as const
        )
    );

    yield* foldKeptDates(into, from);
    // The merged person becomes a tombstone: no data, and a pointer to the survivor. The row stays, so that the
    // history that refers to it (who granted a place) still has a person to name.
    const now = yield* DateTime.now;
    yield* anonymisePerson(from, now);
    // What the person chose on a form (a field of study) is not kept on the tombstone, which names its survivor.
    yield* aggregates
      .updateRoot(from, personRoot, {
        fieldOfStudyId: null,
        mergedInto: into.id,
      })
      .pipe(Effect.orDie);

    return tally(noCounts, written);
  });

  return { merge };
};
