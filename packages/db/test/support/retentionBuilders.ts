/**
 * One row per declared retention rule (spec 0007b, falsifier 2). `builders` is keyed by the rule's id (its table and the
 * columns that share its retention), so a rule that the catalog gains has no builder until one is written here, and the
 * test that every rule has one fails first. A builder inserts the rows that make the rule's period start at a known
 * instant, and says where to look to see whether the rule has acted. The table-driven test derives the rest: the
 * instant one second inside the period, the instant one second outside it, and what each run must leave.
 *
 * The rows are written with SQL, as a fixture writes outside a command: the instants are the point, and no command
 * lets a caller choose them.
 */
import { EmailAddress, OutboxMessage } from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { encodeJson } from "./json.ts";

/** The rows that a builder may attach to: a person, a team and a position. The person is already created. */
export interface Fixture {
  readonly personId: number;
  readonly positionId: number;
  readonly tag: string;
  readonly teamId: number;
}

/** What a builder made: when the rule's period starts for its row, and whether the row is still as it was. */
interface Built {
  readonly present: Effect.Effect<boolean, never, SqlClient>;
  readonly start: DateTime.Utc;
}

export type Builder = (
  fixture: Fixture
) => Effect.Effect<Built, never, SqlClient>;

/**
 * The start of the period of the rules that run from a column or from the person's last activity: the middle of a
 * January day in Oslo winter time. No daylight-saving change lies within years of it, so adding a period and taking it
 * away again lands on the same wall-clock hour.
 */
const WINTER = DateTime.makeUnsafe("2026-01-15T11:00:00Z");

/** The end of Høst 2020 in Oslo: midnight at the start of 2021 (the start of the periods of a membership of that term). */
export const HOST_2020_ENDS = DateTime.makeUnsafe("2020-12-31T23:00:00Z");

/** A date so far ahead that a person created then is never expired by the runs of these tests. */
export const FAR_AHEAD = DateTime.makeUnsafe("2100-01-01T12:00:00Z");

const at = (instant: DateTime.Utc): Date => DateTime.toDateUtc(instant);

/** The 64 hex characters that a stored code hash and a file key's hash must be. */
const SHA = "a".repeat(64);

const flag = (rows: readonly { readonly present: boolean }[]): boolean =>
  rows[0]?.present === true;

/** Sets when the person was created: the start of the period of a person with no engagement. */
export const createdAt = Effect.fnUntraced(function* createdAt(
  personId: number,
  instant: DateTime.Utc
) {
  const sql = yield* SqlClient;
  yield* sql`update person set created_at = ${at(instant)} where id = ${personId}`;
}, Effect.orDie);

/** A builder for a rule that starts at the person's last activity end: the person's own creation. */
const fromActivity =
  (
    write: (
      sql: SqlClient,
      fixture: Fixture
    ) => Effect.Effect<unknown, SqlError>,
    present: (
      sql: SqlClient,
      fixture: Fixture
    ) => Effect.Effect<boolean, SqlError>
  ): Builder =>
  (fixture) =>
    Effect.gen(function* buildFromActivity() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, WINTER);
      yield* Effect.orDie(write(sql, fixture));

      return { present: Effect.orDie(present(sql, fixture)), start: WINTER };
    });

const authUser = (sql: SqlClient, { personId, tag }: Fixture) =>
  sql`insert into auth_user (id, created_at, email, name, person_id, updated_at)
    values (${`user-${tag}`}, ${at(WINTER)}, ${`${tag}.auth@example.org`}, ${`Auth ${tag}`}, ${personId}, ${at(WINTER)})`;

export const builders = {
  "account(person_id,state)": fromActivity(
    (sql, { personId }) =>
      sql`insert into account ${sql.insert({ person_id: personId, state: "Active" })}`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from account where person_id = ${personId}) as present`,
        flag
      )
  ),
  "admin_grant(granted_by,person_id,until)": (fixture) =>
    Effect.gen(function* buildGrant() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      // A later place keeps the person active, so that the person core does not expire inside the period of the first.
      yield* Effect.orDie(
        sql`insert into admin_grant (person_id, until) values (${fixture.personId}, ${at(WINTER)}), (${fixture.personId}, ${at(FAR_AHEAD)})`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from admin_grant where person_id = ${fixture.personId} and until = ${at(WINTER)}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "alumni_request(engagement_end,person_id,requested_at)": fromActivity(
    (sql, { personId }) =>
      sql`insert into alumni_request (engagement_end, person_id, requested_at)
        values (${at(WINTER)}, ${personId}, ${at(WINTER)})`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from alumni_request where person_id = ${personId}) as present`,
        flag
      )
  ),
  "audit_log(action,at,client,entity,entity_key,person_id,session_id)": (
    fixture
  ) =>
    Effect.gen(function* buildAudit() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into audit_log (action, at, entity, entity_key, system_job)
          values ('retention.ran', ${at(WINTER)}, 'Retention', ${fixture.tag}, 'retention')`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from audit_log where entity_key = ${fixture.tag}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "auth_account(access_token,access_token_expires_at,account_id,created_at,credential_version,id_token,password,provider_id,refresh_token,refresh_token_expires_at,scope,updated_at,user_id)":
    fromActivity(
      (sql, fixture) =>
        Effect.andThen(
          authUser(sql, fixture),
          sql`insert into auth_account (id, account_id, created_at, provider_id, updated_at, user_id)
            values (${`account-${fixture.tag}`}, ${fixture.tag}, ${at(WINTER)}, 'credential', ${at(WINTER)}, ${`user-${fixture.tag}`})`
        ),
      (sql, { tag }) =>
        Effect.map(
          sql<{
            present: boolean;
          }>`select exists (select 1 from auth_account where id = ${`account-${tag}`}) as present`,
          flag
        )
    ),
  "auth_session(created_at,expires_at,ip_address,token,updated_at,user_agent,user_id)":
    (fixture) =>
      Effect.gen(function* buildSession() {
        const sql = yield* SqlClient;
        yield* createdAt(fixture.personId, FAR_AHEAD);
        yield* Effect.orDie(authUser(sql, fixture));
        yield* Effect.orDie(
          sql`insert into auth_session (id, created_at, expires_at, token, updated_at, user_id)
            values (${`session-${fixture.tag}`}, ${at(WINTER)}, ${at(WINTER)}, ${`token-${fixture.tag}`}, ${at(WINTER)}, ${`user-${fixture.tag}`})`
        );

        return {
          present: Effect.orDie(
            Effect.map(
              sql<{
                present: boolean;
              }>`select exists (select 1 from auth_session where id = ${`session-${fixture.tag}`}) as present`,
              flag
            )
          ),
          start: WINTER,
        };
      }),
  "auth_user(created_at,email,email_verified,image,name,person_id,updated_at)":
    fromActivity(
      (sql, fixture) => authUser(sql, fixture),
      (sql, { tag }) =>
        Effect.map(
          sql<{
            present: boolean;
          }>`select exists (select 1 from auth_user where id = ${`user-${tag}`}) as present`,
          flag
        )
    ),
  "auth_verification(created_at,expires_at,identifier,updated_at,value)": (
    fixture
  ) =>
    Effect.gen(function* buildVerification() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into auth_verification (id, created_at, expires_at, identifier, updated_at, value)
          values (${`verification-${fixture.tag}`}, ${at(WINTER)}, ${at(WINTER)}, ${`${fixture.tag}@example.org`}, ${at(WINTER)}, 'x')`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from auth_verification where id = ${`verification-${fixture.tag}`}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "captured_mail(recipient,sent_at,subject,text)": (fixture) =>
    Effect.gen(function* buildCapturedMail() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into captured_mail (recipient, sent_at, subject, text)
          values (${`${fixture.tag}@example.org`}, ${at(WINTER)}, 'Emne', 'Tekst')`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from captured_mail where recipient = ${`${fixture.tag}@example.org`}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "captured_slack(channel,sent_at,text)": (fixture) =>
    Effect.gen(function* buildCapturedSlack() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into captured_slack (channel, sent_at, text)
          values (${fixture.tag}, ${at(WINTER)}, 'Tekst')`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from captured_slack where channel = ${fixture.tag}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "code(expires_at,hash,purpose,subject,used_at)": (fixture) =>
    Effect.gen(function* buildCode() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into code (expires_at, hash, purpose, subject)
          values (${at(WINTER)}, ${SHA}, 'resetPassword', ${fixture.personId})`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from code where subject = ${fixture.personId}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "company_address(address,person_id)": fromActivity(
    (sql, { personId, tag }) =>
      sql`insert into company_address (address, person_id)
        values (${`${tag.toLowerCase()}@vektorprogrammet.no`}, ${personId})`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from company_address where person_id = ${personId}) as present`,
        flag
      )
  ),
  "consent(decided_at,given_at,kind,person_id,text_version,withdrawn_at)":
    fromActivity(
      (sql, { personId }) =>
        sql`insert into consent (given_at, kind, person_id, text_version)
          values (${at(WINTER)}, 'news', ${personId}, 1)`,
      (sql, { personId }) =>
        Effect.map(
          sql<{
            present: boolean;
          }>`select exists (select 1 from consent where person_id = ${personId}) as present`,
          flag
        )
    ),
  "ending_soon_digest(person_id,recorded_at,term,year)": fromActivity(
    (sql, { personId }) =>
      sql`insert into ending_soon_digest (person_id, recorded_at, term, year)
        values (${personId}, ${at(WINTER)}, 'HOST', 2025)`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from ending_soon_digest where person_id = ${personId}) as present`,
        flag
      )
  ),
  "job_run(last_error)": (fixture) =>
    Effect.gen(function* buildJobRun() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into job_run (job, lease_until, outcome, period)
          values ('semesters', ${at(WINTER)}, 'failed', ${fixture.tag})`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from job_run where job = 'semesters' and period = ${fixture.tag}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "membership(end_ordinal,end_term,end_year,leader,person_id,position_id,start_ordinal,start_term,start_year,team_id)":
    (fixture) =>
      Effect.gen(function* buildMembership() {
        const sql = yield* SqlClient;
        yield* createdAt(fixture.personId, FAR_AHEAD);
        // A later membership keeps the person active, so that the person core does not expire inside the period of the first.
        yield* Effect.orDie(
          sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
            values ('HOST', 2020, ${fixture.personId}, ${fixture.positionId}, 'HOST', 2020, ${fixture.teamId}),
              ('HOST', 2099, ${fixture.personId}, ${fixture.positionId}, 'HOST', 2099, ${fixture.teamId})`
        );

        return {
          present: Effect.orDie(
            Effect.map(
              sql<{
                present: boolean;
              }>`select exists (select 1 from membership where person_id = ${fixture.personId} and end_year = 2020) as present`,
              flag
            )
          ),
          start: HOST_2020_ENDS,
        };
      }),
  "outbox(last_error,payload)": (fixture) =>
    Effect.gen(function* buildOutbox() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);

      const payload = yield* Effect.orDie(
        encodeJson(
          OutboxMessage.cases.Email.make({
            replyTo: null,
            subject: "Emne",
            text: "Tekst",
            to: EmailAddress.make(`${fixture.tag}@example.org`),
          })
        )
      );

      yield* Effect.orDie(
        sql`insert into outbox (created_at, kind, next_attempt_at, payload)
          values (${at(WINTER)}, 'Email', ${at(WINTER)}, ${payload}::jsonb)`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from outbox where payload ->> 'to' = ${`${fixture.tag}@example.org`}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
  "person(company_email,email,email_verified,name,photo_key)": fromActivity(
    () => Effect.void,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from person where id = ${personId} and anonymised_at is null) as present`,
        flag
      )
  ),
  "public_file(uploaded_by)": fromActivity(
    (sql, { personId, tag }) =>
      sql`insert into public_file (content_type, key, name, sha256, size, uploaded_at, uploaded_by)
        values ('image/png', ${`${SHA}.png`}, ${`${tag}.png`}, ${SHA}, 10, ${at(WINTER)}, ${personId})`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from public_file where uploaded_by = ${personId}) as present`,
        flag
      )
  ),
  "welcome_ledger(person_id,recorded_at)": fromActivity(
    (sql, { personId }) =>
      sql`insert into welcome_ledger (person_id, recorded_at)
        values (${personId}, ${at(WINTER)})`,
    (sql, { personId }) =>
      Effect.map(
        sql<{
          present: boolean;
        }>`select exists (select 1 from welcome_ledger where person_id = ${personId}) as present`,
        flag
      )
  ),
  "workspace_report(accounts,department_lists,groups,issues,unmanaged)": (
    fixture
  ) =>
    Effect.gen(function* buildWorkspaceReport() {
      const sql = yield* SqlClient;
      yield* createdAt(fixture.personId, FAR_AHEAD);
      yield* Effect.orDie(
        sql`insert into workspace_report (actual, mode, period, semester_term, semester_year, started_at, status)
          values ('read', 'dry-run', ${fixture.tag}, 'HOST', 2026, ${at(WINTER)}, 'running')`
      );

      return {
        present: Effect.orDie(
          Effect.map(
            sql<{
              present: boolean;
            }>`select exists (select 1 from workspace_report where period = ${fixture.tag}) as present`,
            flag
          )
        ),
        start: WINTER,
      };
    }),
} satisfies Readonly<Record<string, Builder>>;

/**
 * The other tables whose rows a rule's fixture makes expire in the same run, besides the rule's own table and the
 * person (which every rule that starts at the person's last activity end also anonymises). Keyed by rule id.
 */
export const alsoChanges = {
  "auth_account(access_token,access_token_expires_at,account_id,created_at,credential_version,id_token,password,provider_id,refresh_token,refresh_token_expires_at,scope,updated_at,user_id)":
    ["auth_user"],
} satisfies Readonly<Record<string, readonly string[]>>;
