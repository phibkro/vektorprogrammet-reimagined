import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Array as Arr, Effect, Record as Rec, Schema } from "effect";
import type { DateTime } from "effect";

import type { PersonId } from "../../../core/ids.ts";
/**
 * The export of one person's data (spec 0007b): the rows of every table whose person relation declares `Rows`, minus
 * the columns that the declaration leaves out (a credential), as JSON. It is one statement, so it is one snapshot: a
 * write that commits while the export runs is in all of the tables or in none. It writes nothing and takes no lock.
 */
import { Catalog } from "../../../features/personal-data/domain/catalog.ts";
import type { CatalogOf } from "../../../features/personal-data/domain/catalog.ts";
import {
  exportedTables,
  editorialReviewReasons,
} from "../../../features/personal-data/domain/derive.ts";
import { PersonExport } from "../../../features/personal-data/domain/services.ts";
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
  )}) || jsonb_build_object(
    'supabase_users', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'phone', u.phone, 'created_at', u.created_at,
      'updated_at', u.updated_at, 'last_sign_in_at', u.last_sign_in_at,
      'email_confirmed_at', u.email_confirmed_at, 'phone_confirmed_at', u.phone_confirmed_at
    )), '[]'::jsonb) from vektor_private.users u where u.person_id = ${String(personId)}),
    'supabase_identities', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'provider', i.provider, 'created_at', i.created_at, 'updated_at', i.updated_at, 'last_sign_in_at', i.last_sign_in_at
    )), '[]'::jsonb) from vektor_private.identities i join vektor_private.users u on u.id = i.user_id where u.person_id = ${String(personId)}),
    'supabase_sessions', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'created_at', s.created_at, 'updated_at', s.updated_at, 'not_after', s.not_after, 'user_agent', s.user_agent, 'ip', s.ip::text
    )), '[]'::jsonb) from vektor_private.sessions s join vektor_private.users u on u.id = s.user_id where u.person_id = ${String(personId)})
  ) as tables`;

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

    return {
      editorialReview: editorialReviewReasons(catalog),
      exportedAt: now,
      personId,
      tables,
    };
  }, Effect.orDie);
