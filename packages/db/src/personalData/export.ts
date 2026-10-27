/**
 * The export of one person's data (spec 0007b): the rows of every table whose person relation declares `Rows`, minus
 * the columns that the declaration leaves out (a credential), as JSON. It is one statement, so it is one snapshot: a
 * write that commits while the export runs is in all of the tables or in none. It writes nothing and takes no lock.
 */
import {
  Catalog,
  PersonExport,
  exportedTables,
} from "@vektorprogrammet/domain";
import type { CatalogOf, PersonId } from "@vektorprogrammet/domain";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Array as Arr, Effect, Record as Rec, Schema } from "effect";
import type { DateTime } from "effect";

import type { Drizzle } from "../internal/drizzle.ts";
import { aboutPeople, identifier } from "./sql.ts";

const catalog: CatalogOf = Catalog;

const decodeTables = Schema.decodeUnknownEffect(PersonExport.fields.tables);

/** The columns that a row leaves out, as a text array that `jsonb - text[]` removes. */
const omitted = (columns: readonly string[]): SQL =>
  Arr.isReadonlyArrayEmpty(columns)
    ? sql`array[]::text[]`
    : sql`array[${sql.join(
        Arr.map(columns, (column) => sql`${column}::text`),
        sql`, `
      )}]::text[]`;

/** `jsonb_build_object` of every exported table: its name, and the array of the person's rows. */
const tablesOf = (personId: number): SQL =>
  sql`select jsonb_build_object(${sql.join(
    Arr.map(
      exportedTables(catalog),
      ({ exclude, key, table }) =>
        sql`${table}::text, (select coalesce(jsonb_agg(to_jsonb(${identifier(table)}) - ${omitted(Rec.keys(exclude))}), '[]'::jsonb) from ${identifier(table)} where ${aboutPeople(table, key, { addresses: [], ids: [personId] })})`
    ),
    sql`, `
  )}) as tables`;

export const personalDataExport = (db: Drizzle["Service"]) =>
  Effect.fn("PersonalDataStore.exportOf")(function* exportOf(
    personId: PersonId,
    now: DateTime.Utc
  ) {
    const [row] = yield* db.execute<{ tables: unknown }>(
      tablesOf(personId),
      "objects"
    );

    // A row that does not decode is a statement that does not return what the catalog says: a defect, never an export.
    const tables = yield* decodeTables(row?.tables);

    return { exportedAt: now, personId, tables };
  }, Effect.orDie);
