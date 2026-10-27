/**
 * The PostgreSQL target: a Neon branch (or a local database), written directly
 * through `@effect/sql-pg` and Drizzle with `@vektorprogrammet/db`'s schema, not
 * through Hyperdrive.
 *
 * `replaceAll` is the whole write in one transaction: truncate every Phase 1
 * table the importer owns, insert the plan in foreign-key order, advance the
 * identity sequences past the kept legacy ids, and read the row counts back.
 * A failure anywhere, including a count that differs from the plan, rolls the
 * target back to its previous state. There is no `CASCADE`: an unlisted reference makes the truncate fail.
 * Targets with credentials or durable integration activity are refused before replacement: the importer cannot restore them.
 */
import { PgClient } from "@effect/sql-pg";
import { schema } from "@vektorprogrammet/db";
import { getTableName, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { Redacted } from "effect";
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Record as Rec,
  Schema,
} from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { TARGET_TABLES } from "./transform/plan.ts";
import type { TargetRows, TargetTable } from "./transform/plan.ts";

type InsertError = EffectDrizzleQueryError | SqlError;

export class TargetWriteError extends Schema.TaggedError<
  TargetWriteError,
  { readonly brand: unique symbol }
>()("TargetWriteError", {
  cause: Schema.Defect(),
  step: Schema.String,
}) {}

const step =
  (name: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, TargetWriteError, R> =>
    Effect.mapError(
      effect,
      (cause) => new TargetWriteError({ cause, step: name })
    );

/** The Drizzle table of each target table name. */
const TABLES = {
  admission_period: schema.admissionPeriod,
  department: schema.department,
  field_of_study: schema.fieldOfStudy,
  public_file: schema.publicFile,
  semester: schema.semester,
  social_event: schema.socialEvent,
} as const;

/** Later-phase tables to lock. Durable credentials, messages and job records are never erased by replacement. */
const BUILT_ON_TABLES = [
  schema.authSession,
  schema.authAccount,
  schema.authUser,
  schema.code,
  schema.account,
  schema.welcomeLedger,
  schema.outbox,
  schema.capturedMail,
  schema.capturedSlack,
  schema.jobRun,
  schema.workspaceReport,
  schema.endingSoonDigest,
  schema.adminGrant,
  schema.membership,
  schema.companyAddress,
  schema.team,
  schema.person,
] as const;

/** Tables whose integer `id` is an identity column; their sequences follow the kept legacy ids. */
const IDENTITY_TABLES = [
  schema.department,
  schema.semester,
  schema.fieldOfStudy,
  schema.admissionPeriod,
  schema.socialEvent,
] as const;

/** Rows per `INSERT` statement, far below PostgreSQL's 65 535 bind parameters. */
const BATCH = 500;

/** Writes table rows in batches through the supplied Drizzle insert. */
const inBatches = <A>(
  table: TargetTable,
  values: readonly A[],
  write: (chunk: A[]) => Effect.Effect<unknown, InsertError>
) =>
  Effect.forEach(Arr.chunksOf(values, BATCH), write, {
    discard: true,
  }).pipe(step(`insert ${table}`));

export class ImportTarget extends Context.Service<
  ImportTarget,
  {
    /** Replaces the target's Phase 1 data with rows; returns the stored row count per table. */
    readonly replaceAll: (
      rows: TargetRows
    ) => Effect.Effect<Readonly<Record<TargetTable, number>>, TargetWriteError>;
  }
>()("@vektorprogrammet/import/ImportTarget") {
  /** Writes through the ambient `PgClient`. */
  static readonly layer = Layer.effect(
    ImportTarget,
    Effect.gen(function* layer() {
      const pg = yield* PgClient.PgClient;
      const db = yield* PgDrizzle.makeWithDefaults();

      const date = DateTime.toDateUtc;

      const toDatabaseWindow = <
        A extends {
          readonly endsAt: DateTime.Utc;
          readonly startsAt: DateTime.Utc;
        },
      >(
        row: A
      ) => ({
        ...row,
        endsAt: date(row.endsAt),
        startsAt: date(row.startsAt),
      });

      const replaceAll = Effect.fn("ImportTarget.replaceAll")(
        function* replaceAll(rows: TargetRows) {
          const tables = [
            ...Arr.map(TARGET_TABLES, ({ table }) => TABLES[table]),
            ...BUILT_ON_TABLES,
          ];

          // Hold the locks through the check and truncate so no protected row can slip between them.
          yield* db
            .execute(
              sql`lock table ${sql.join(tables, sql`, `)} in access exclusive mode`
            )
            .pipe(step("lock target"));

          const protectedRows = yield* Effect.forEach(
            [
              schema.account,
              schema.code,
              schema.authUser,
              schema.welcomeLedger,
              schema.outbox,
              schema.capturedMail,
              schema.capturedSlack,
              schema.jobRun,
              schema.workspaceReport,
            ],
            (table) => db.$count(table).pipe(step("check accounts"))
          );

          if (Arr.some(protectedRows, (count) => count > 0)) {
            return yield* new TargetWriteError({
              cause:
                "target contains accounts, credentials or durable integration activity; replacing them is outside this importer",
              step: "protect accounts",
            });
          }

          yield* db
            .execute(
              sql`truncate table ${sql.join(tables, sql`, `)} restart identity`
            )
            .pipe(step("truncate"));

          yield* inBatches(
            "public_file",
            Arr.map(rows.public_file, (row) => ({
              ...row,
              uploadedAt: date(row.uploadedAt),
            })),
            (chunk) => db.insert(schema.publicFile).values(chunk)
          );
          yield* inBatches("department", rows.department, (chunk) =>
            db.insert(schema.department).values(chunk)
          );
          yield* inBatches("semester", rows.semester, (chunk) =>
            db.insert(schema.semester).values(chunk)
          );
          yield* inBatches("field_of_study", rows.field_of_study, (chunk) =>
            db.insert(schema.fieldOfStudy).values(chunk)
          );
          yield* inBatches(
            "admission_period",
            Arr.map(rows.admission_period, toDatabaseWindow),
            (chunk) => db.insert(schema.admissionPeriod).values(chunk)
          );
          yield* inBatches(
            "social_event",
            Arr.map(rows.social_event, toDatabaseWindow),
            (chunk) => db.insert(schema.socialEvent).values(chunk)
          );

          yield* Effect.forEach(
            IDENTITY_TABLES,
            (table) =>
              db.execute(
                sql`select setval(pg_get_serial_sequence(${getTableName(table)}, 'id'),
                                coalesce(max(${table.id}), 1), max(${table.id}) is not null)
                  from ${table}`
              ),
            { discard: true }
          ).pipe(step("advance identity sequences"));

          const counts = yield* Effect.forEach(TARGET_TABLES, ({ table }) =>
            db.$count(TABLES[table]).pipe(
              Effect.map((count) => [table, count] as const),
              step(`count ${table}`)
            )
          );

          const rowsOut: Record<TargetTable, number> = Rec.fromEntries(counts);

          const mismatched = Arr.filter(
            TARGET_TABLES,
            ({ table }) => rowsOut[table] !== rows[table].length
          );

          if (mismatched.length > 0) {
            return yield* new TargetWriteError({
              cause: `stored row counts differ from the plan: ${Arr.join(
                Arr.map(mismatched, (t) => t.table),
                ", "
              )}`,
              step: "reconcile",
            });
          }

          return rowsOut;
        },
        pg.withTransaction
      );

      return ImportTarget.of({
        replaceAll: (rows) =>
          replaceAll(rows).pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(new TargetWriteError({ cause, step: "transaction" }))
            )
          ),
      });
    })
  );
}

/**
 * The target client: a direct connection (not Hyperdrive), so prepared
 * statements stay on; two connections are plenty for a sequential import.
 */
export const targetPgLayer = (url: Redacted.Redacted) =>
  PgClient.layer({
    applicationName: "vektorprogrammet-import",
    maxConnections: 2,
    url,
  });
