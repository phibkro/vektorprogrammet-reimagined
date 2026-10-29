/**
 * What the specs read back from the database the harness started (`E2E_DATABASE_URL`): typed, parameterised
 * queries that decode every row with a Schema. `runDatabase` is the one place an Effect becomes the Promise
 * the Playwright runner awaits.
 */
import { PgClient } from "@effect/sql-pg";
import { mintCode } from "@vektorprogrammet/domain";
import type { CodePurpose } from "@vektorprogrammet/domain";
import { Config, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { webCryptoLayer } from "../../src/server/webCrypto.ts";

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

/** Administrator-requested Workspace runs, waiting or completed. */
export const workspaceRequestCount = countOf(
  (sql) =>
    sql`select count(*)::int as n from job_run where job = 'workspaceSync' and period like 'request:%'`
);

export const completedWorkspaceRequestCount = countOf(
  (sql) =>
    sql`select count(*)::int as n from job_run where job = 'workspaceSync' and period like 'request:%' and outcome = 'done'`
);

/** The runs that the ledger holds for one job: a job that the scheduler never ran has none. */
export const jobRunCount = (job: string) =>
  countOf(
    (sql) =>
      sql`select count(*)::int as n from job_run where job = ${job} and outcome = 'done'`
  );

/** Whether the capture sink persisted this outbox delivery. */
export const capturedSlackFor = (key: string) =>
  countOf(
    (sql) =>
      sql`select count(*)::int as n from captured_slack where delivery_key = ${key}`
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

/** The fake non-production mailbox is the only persisted copy of an activation/reset link. */
export const capturedMailTo = (recipient: string) =>
  rowsOf(
    Schema.Struct({ text: Schema.String }),
    (sql) =>
      sql`select text from captured_mail where recipient = ${recipient} order by id desc`
  );

export const accountStateOf = (email: string) =>
  rowsOf(
    Schema.Struct({ state: Schema.String }),
    (sql) =>
      sql`select a.state from account a join person p on p.id = a.person_id where p.email = ${email}`
  );

export const sessionCountOf = (email: string) =>
  countOf(
    (sql) =>
      sql`select count(*)::int as n from auth_session s join auth_user u on u.id = s.user_id where u.email = ${email}`
  );

/** Fake rows for the reset-response comparison. They have no Better Auth credentials. */
export const seedResetCases = Effect.gen(function* seedResetCases() {
  const sql = yield* SqlClient;
  yield* sql`insert into person (name, email, company_email, field_of_study_id)
    select names.name, names.email, names.company, (select id from field_of_study order by id limit 1)
    from (values ('Reset Active', 'privacy-active@example.org', 'privacy-company@example.org'),
                 ('Reset Invited', 'privacy-invited@example.org', null),
                 ('Reset Deactivated', 'privacy-deactivated@example.org', null)) as names(name, email, company)`;
  yield* sql`insert into account (person_id, state)
    select id, case email when 'privacy-active@example.org' then 'Active' when 'privacy-invited@example.org' then 'Invited' else 'Deactivated' end
    from person where email in ('privacy-active@example.org', 'privacy-invited@example.org', 'privacy-deactivated@example.org')`;
});

export const resetIntentCount = countOf(
  (sql) =>
    sql`select count(*)::int as n from outbox where kind = 'IssueCode' and payload ->> 'purpose' = 'resetPassword'`
);

export const deactivateResetFixture = Effect.flatMap(
  SqlClient,
  (sql) =>
    sql`update account set state = 'Deactivated' where person_id = (select id from person where email = 'privacy-active@example.org')`
);

/** Install only the hash of a fresh code for a real HTTP state-precondition probe. */
export const codeFor = (email: string, purpose: CodePurpose) =>
  Effect.gen(function* seedCode() {
    const sql = yield* SqlClient;
    const { hash, token } = yield* mintCode().pipe(Effect.orDie);
    yield* sql`insert into code (purpose, subject, hash, expires_at, state)
      select ${purpose}, id, ${hash}, now() + interval '1 hour', 'Usable' from person where email = ${email}
      on conflict (purpose, subject) do update set hash = excluded.hash, expires_at = excluded.expires_at, state = 'Usable'`;

    return token;
  }).pipe(Effect.provide(webCryptoLayer));

const OutboxRow = Schema.Struct({
  id: Schema.Int,
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
    sql`select id, kind, created_at::text as "queuedAt" from outbox order by id`
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

const AdminGrantRow = Schema.Struct({
  id: Schema.Int,
  person: Schema.String,
  until: Schema.String,
});

/** The admin list as stored, in id order: who holds a place and until when. */
export const adminGrantRows = rowsOf(
  AdminGrantRow,
  (sql) =>
    sql`select g.id, p.name as person, g.until::text as until
      from admin_grant g join person p on p.id = g.person_id
      order by g.id`
);

/** Sets the end of a person's admin places (a timestamp literal, as `adminGrantRows` reads it). */
export const endAdminPlacesAt = (person: string, until: string) =>
  Effect.flatMap(
    SqlClient,
    (sql) =>
      sql`update admin_grant set until = ${until}::timestamptz
        where person_id = (select id from person where name = ${person})`
  );

/** Ends a person's admin places within the hour: still valid now, gone before the semester ends. */
export const endAdminPlacesSoon = (person: string) =>
  Effect.flatMap(
    SqlClient,
    (sql) =>
      sql`update admin_grant set until = now() + interval '1 hour'
        where person_id = (select id from person where name = ${person})`
  );

/** Gives `person` a place until `until`, granted by `grantedBy`; the new place's id. */
export const addAdminPlace = (
  person: string,
  grantedBy: string,
  until: string
) =>
  rowOf(
    Schema.Struct({ id: Schema.Int }),
    (sql) =>
      sql`insert into admin_grant (person_id, granted_by, until)
        select holder.id, granter.id, ${until}::timestamptz
        from person holder, person granter
        where holder.name = ${person} and granter.name = ${grantedBy}
        returning id`
  ).pipe(Effect.map(({ id }) => id));

export const deleteAdminPlace = (id: number) =>
  Effect.flatMap(
    SqlClient,
    (sql) => sql`delete from admin_grant where id = ${id}`
  );

const ConsentRow = Schema.Struct({
  kind: Schema.String,
  textVersion: Schema.Int,
  withdrawn: Schema.Boolean,
});

/** The consent records of the person with this address, by kind: the text version they saw, and whether they withdrew. */
export const consentsOf = (email: string) =>
  rowsOf(
    ConsentRow,
    (sql) =>
      sql`select c.kind, c.text_version as "textVersion", c.withdrawn_at is not null as withdrawn
        from consent c join person p on p.id = c.person_id
        where p.email = ${email}
        order by c.kind`
  );

/** A person with no engagement whose record is three years old, which the nightly run must anonymise; the id. */
export const insertExpiredPerson = (name: string, email: string) =>
  rowOf(
    Schema.Struct({ id: Schema.Int }),
    (sql) =>
      sql`insert into person (name, email, field_of_study_id, created_at)
        select ${name}, ${email}, id, now() - interval '3 years'
        from field_of_study order by id limit 1
        returning id`
  ).pipe(Effect.map(({ id }) => id));

/** The id of the person with this address. */
export const personIdOf = (email: string) =>
  rowOf(
    Schema.Struct({ id: Schema.Int }),
    (sql) => sql`select id from person where email = ${email}`
  ).pipe(Effect.map(({ id }) => id));

const PersonCore = Schema.Struct({
  anonymised: Schema.Boolean,
  email: Schema.String,
  mergedInto: Schema.NullOr(Schema.Int),
  name: Schema.String,
});

/** What the person row holds now: the core fields, whether it was anonymised, and the record it was merged into. */
export const personCore = (id: number) =>
  rowOf(
    PersonCore,
    (sql) =>
      sql`select name, email, anonymised_at is not null as anonymised, merged_into as "mergedInto"
        from person where id = ${id}`
  );

/** The counts of the latest retention run's audit row: integers per table, never a value. */
export const latestRetentionCounts = rowOf(
  Schema.Struct({ counts: Schema.Record(Schema.String, Schema.Int) }),
  (sql) =>
    sql`select counts from audit_log where action = 'retention.ran' order by id desc limit 1`
);
