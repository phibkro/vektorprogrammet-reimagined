/**
 * Spec 0007b R4 on the scheduler of spec 0008: the Worker's nightly retention, run as the `scheduled` handler runs it
 * (`runTick` with the retention cron, over the tick's whole Layer: the delivery services, the senders, Better Auth and
 * the Workspace) on a disposable migrated database, in each deployment. One person is due (their only activity is their
 * creation, in 2020). Local and preview change the person and audit `retention.ran`; production, while a period is a
 * proposal, changes nothing and audits `retention.reported`. The three deployments are the controls of each other: the
 * same database, the same person, the same job. The run is recorded in `job_run`, and no message is sent.
 */
import type {
  EmailMessage,
  EmailMessageBuilder,
} from "@cloudflare/workers-types";
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  Catalog,
  JobRegistry,
  retentionIsProposed,
  retentionRules,
} from "@vektorprogrammet/domain";
import type { RetentionMode } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Layer, Redacted, Ref } from "effect";
import { flow } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";

import { Deployment } from "../src/server/deployment";
import { runTick } from "../src/server/runtime";
import type { TickEnv } from "../src/server/runtime";

const PERSON = 701;

/** The database as its owner, for the seed and for reading what the run left. */
const owner = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    DatabaseLive({ maxConnections: 2, url })
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

/** What each mode leaves behind: whether the person is anonymised, and the actions that the run audited. */
const LEFT_BEHIND: Record<
  RetentionMode,
  { readonly actions: string[]; readonly anonymised: boolean }
> = {
  Apply: { actions: ["retention.ran"], anonymised: true },
  ReportOnly: { actions: ["retention.reported"], anonymised: false },
};

/**
 * The mode that a deployment runs in, as the spec words it and read from the declared approvals here, not from the gate
 * that is under test: local and preview always apply, and production applies only when no period is a proposal.
 */
const modeIn = (deployment: Deployment): RetentionMode =>
  deployment !== "production" ||
  Arr.every(
    retentionRules(Catalog),
    ({ retention }) => !retentionIsProposed(retention)
  )
    ? "Apply"
    : "ReportOnly";

/** One person whose last activity is their creation, long ago: due at any time that the run starts. */
const seedDuePerson = Effect.gen(function* seedDuePerson() {
  const sql = yield* SqlClient;
  yield* sql`insert into department (id, city, email, name, short_name) values (${PERSON}, 'Fristad', 'retention@example.org', 'Retention', 'RET')`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (${PERSON}, ${PERSON}, 'Retention', 'RET')`;
  yield* sql`insert into person ${sql.insert([
    {
      created_at: "2020-01-01T00:00:00Z",
      email: "due@example.org",
      field_of_study_id: PERSON,
      id: PERSON,
      name: "Due Person",
    },
  ])}`;
});

/** At the retention cron's minute: 02:17 UTC, the time the Worker's trigger fires. */
const SCHEDULED_AT = DateTime.makeUnsafe("2026-10-27T02:17:00Z");

/**
 * The Worker's bindings as a deployment has them: a production run needs every sender binding, and the fake `send_email`
 * records what it is asked to send, which no retention run asks.
 */
const bindings = (
  deployment: Deployment,
  connectionString: string,
  sent: Ref.Ref<readonly (EmailMessage | EmailMessageBuilder)[]>
): TickEnv => ({
  BETTER_AUTH_SECRET: "retention-test-signing-key-not-a-secret",
  DEPLOYMENT: deployment,
  HYPERDRIVE: { connectionString },
  MAIL_FROM: "noreply@retention.example",
  SEND_EMAIL: {
    send: flow(
      (message: EmailMessage | EmailMessageBuilder) =>
        Ref.update(sent, (all) => [...all, message]).pipe(
          Effect.as({ messageId: "fake" })
        ),
      Effect.runPromise
    ),
  },
  SITE_URL: "https://retention.example",
  SLACK_WEBHOOK_URL: "https://hooks.example.invalid/fake",
});

const whatTheRunLeft = Effect.gen(function* whatTheRunLeft() {
  const sql = yield* SqlClient;

  const [person] = yield* sql<{
    readonly anonymised: boolean;
  }>`select anonymised_at is not null as anonymised from person where id = ${PERSON}`;

  const audit = yield* sql<{
    readonly action: string;
    readonly person: number;
  }>`select action, (counts->>'person')::int as person from audit_log where system_job = 'retention' order by id`;

  const runs = yield* sql<{
    readonly job: string;
    readonly outcome: string;
  }>`select job, outcome from job_run order by job`;

  return {
    actions: Arr.map(audit, (row) => row.action),
    anonymised: person?.anonymised ?? null,
    counted: Arr.map(audit, (row) => row.person),
    runs: Arr.map(runs, (row) => `${row.job}:${row.outcome}`),
  };
});

for (const deployment of Deployment.literals) {
  layer(owner, { excludeTestServices: true })(
    `spec 0007b R4: the Worker's nightly run in ${deployment}`,
    (it) => {
      it.effect(
        `${deployment} runs in the mode that its approvals allow: ${modeIn(deployment)}`,
        () =>
          Effect.gen(function* nightlyRun() {
            const url = yield* TestDatabaseUrl;
            yield* seedDuePerson;

            const sent = yield* Ref.make<
              readonly (EmailMessage | EmailMessageBuilder)[]
            >([]);

            // The platform's trigger: the retention cron fires, and `runTick` runs what is due of that cron.
            yield* Effect.promise(
              runTick.bind(
                null,
                bindings(deployment, Redacted.value(url), sent),
                {
                  cron: JobRegistry.retention.schedule.cron,
                  scheduledTime: DateTime.toEpochMillis(SCHEDULED_AT),
                },
                undefined
              )
            );

            const left = LEFT_BEHIND[modeIn(deployment)];

            assert.deepStrictEqual(yield* whatTheRunLeft, {
              actions: left.actions,
              anonymised: left.anonymised,
              // The one person is counted in either mode: a report says what a run would change.
              counted: [1],
              // Only the retention job ran, as one claimed period, and it finished.
              runs: ["retention:done"],
            });
            assert.deepStrictEqual(yield* Ref.get(sent), []);
          })
      );
    }
  );
}
