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

/** Every row of `statement`, decoded with `Row`. */
const rowsOf = <S extends Schema.Constraint>(Row: S, statement: Statement) =>
  Effect.flatMap(SqlClient, (sql) =>
    Effect.flatMap(
      statement(sql),
      Schema.decodeUnknownEffect(Schema.Array(Row))
    )
  );

const MembershipRow = Schema.Struct({
  endTerm: Schema.String,
  endYear: Schema.Int,
  id: Schema.Int,
  leader: Schema.Boolean,
  position: Schema.String,
  startTerm: Schema.String,
  startYear: Schema.Int,
});

/** Membership history for a named person and team, oldest first. */
export const membershipsNamed = (teamName: string, personName: string) =>
  rowsOf(
    MembershipRow,
    (sql) =>
      sql`select m.id, m.leader, p.name as position,
          m.start_term as "startTerm", m.start_year as "startYear",
          m.end_term as "endTerm", m.end_year as "endYear"
        from membership m
        join team t on t.id = m.team_id
        join person person on person.id = m.person_id
        join position p on p.id = m.position_id
        where t.name = ${teamName} and person.name = ${personName}
        order by m.start_ordinal, m.id`
  );

const OutboxRow = Schema.Struct({
  kind: Schema.String,
  queuedAt: Schema.String,
});

/**
 * The queued messages, oldest first, each with the instant it was queued. `enqueue` writes all the messages of one
 * command in one INSERT with one instant, so rows of one post share it (a row's `xmin` would not do: delivery
 * updates every row afterwards, in its own transaction).
 */
export const outboxRows = rowsOf(
  OutboxRow,
  (sql) =>
    sql`select kind, created_at::text as "queuedAt" from outbox order by id`
);

const ActiveDepartment = Schema.Struct({
  city: Schema.String,
  email: Schema.String,
  id: Schema.Int,
  name: Schema.String,
  shortName: Schema.String,
  slackChannel: Schema.NullOr(Schema.String),
});

/** The departments the public pages list: the active ones. */
export const activeDepartments = rowsOf(
  ActiveDepartment,
  (sql) =>
    sql`select id, name, short_name as "shortName", city, email, slack_channel as "slackChannel" from department where active order by id`
);

const LEGACY_FILE_HASH = "e".repeat(64);

export const LEGACY_FILE_KEY = `${LEGACY_FILE_HASH}.png`;

/** Registers one file under its legacy upload path, as the importer does when it copies the uploads. */
export const registerLegacyFile = (legacyPath: string) =>
  Effect.flatMap(
    SqlClient,
    (sql) =>
      sql`insert into public_file (key, sha256, content_type, name, size, uploaded_at, legacy_path)
        values (${LEGACY_FILE_KEY}, ${LEGACY_FILE_HASH}, 'image/png', 'e2e.png', 10, now(), ${legacyPath})`
  );

export const forgetLegacyFile = Effect.flatMap(
  SqlClient,
  (sql) => sql`delete from public_file where key = ${LEGACY_FILE_KEY}`
);
