/**
 * What the specs read back from the database the harness started (`E2E_DATABASE_URL`): typed, parameterised
 * queries that decode every row with a Schema. `runDatabase` is the one place an Effect becomes the Promise
 * the Playwright runner awaits.
 */
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

const DatabaseLive = Layer.unwrap(
  Config.Redacted("E2E_DATABASE_URL").pipe(
    Effect.map((url) => PgClient.layer({ maxConnections: 1, url }))
  )
);

export const runDatabase = <A, E>(
  program: Effect.Effect<A, E, SqlClient>
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(DatabaseLive), Effect.orDie));

type Statement = (
  sql: SqlClient
) => Effect.Effect<readonly unknown[], SqlError>;

/** The first row of `statement`, decoded with `Row`; a missing row fails the probe. */
const rowOf = <S extends Schema.Constraint>(Row: S, statement: Statement) =>
  Effect.flatMap(SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: Row,
      execute: () => statement(sql),
    })()
  );

const Count = Schema.Struct({ n: Schema.Int });

const countOf = (statement: Statement) =>
  rowOf(Count, statement).pipe(Effect.map(({ n }) => n));

const Department = Schema.Struct({
  address: Schema.NullOr(Schema.String),
  latitude: Schema.NullOr(Schema.Finite),
  longitude: Schema.NullOr(Schema.Finite),
  name: Schema.String,
  slackChannel: Schema.NullOr(Schema.String),
});

const FieldOfStudy = Schema.Struct({
  departmentId: Schema.Int,
  name: Schema.String,
});

export const departmentRow = (id: number) =>
  rowOf(
    Department,
    (sql) =>
      sql`select name, address, latitude, longitude, slack_channel as "slackChannel" from department where id = ${id}`
  );

export const departmentsInCity = (city: string) =>
  countOf(
    (sql) => sql`select count(*)::int as n from department where city = ${city}`
  );

export const fieldOfStudyRow = (id: number) =>
  rowOf(
    FieldOfStudy,
    (sql) =>
      sql`select name, department_id as "departmentId" from field_of_study where id = ${id}`
  );

export const fieldOfStudyNamed = (name: string) =>
  rowOf(
    FieldOfStudy,
    (sql) =>
      sql`select name, department_id as "departmentId" from field_of_study where name = ${name}`
  );

export const fieldsOfStudyIn = (departmentId: number) =>
  countOf(
    (sql) =>
      sql`select count(*)::int as n from field_of_study where department_id = ${departmentId}`
  );

export const semesterCount = countOf(
  (sql) => sql`select count(*)::int as n from semester`
);

export const auditEntryCount = countOf(
  (sql) => sql`select count(*)::int as n from audit_log`
);
