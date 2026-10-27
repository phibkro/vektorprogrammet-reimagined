/**
 * Spec 0007b R4: the Worker's nightly retention (`runRetention`, the `scheduled` handler's job) over a disposable
 * migrated database, in each deployment. One person is due (their only activity is their creation, in 2020), and the run
 * is started as the cron starts it: from the Worker's bindings. Local and preview change the person and audit
 * `retention.ran`; production, while a period is a proposal, changes nothing and audits `retention.reported`. The three
 * deployments are the controls of each other: the same database, the same person, the same job.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  Catalog,
  retentionIsProposed,
  retentionRules,
} from "@vektorprogrammet/domain";
import type { RetentionMode } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Deployment } from "../src/server/deployment";
import { runRetention } from "../src/server/runtime";

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

const whatTheRunLeft = Effect.gen(function* whatTheRunLeft() {
  const sql = yield* SqlClient;

  const [person] = yield* sql<{
    readonly anonymised: boolean;
  }>`select anonymised_at is not null as anonymised from person where id = ${PERSON}`;

  const audit = yield* sql<{
    readonly action: string;
    readonly person: number;
  }>`select action, (counts->>'person')::int as person from audit_log where system_job = 'retention' order by id`;

  return {
    actions: Arr.map(audit, (row) => row.action),
    anonymised: person?.anonymised ?? null,
    counted: Arr.map(audit, (row) => row.person),
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

            yield* Effect.promise(
              runRetention.bind(null, {
                DEPLOYMENT: deployment,
                HYPERDRIVE: { connectionString: Redacted.value(url) },
                SITE_URL: "https://retention.example",
              })
            );

            const left = LEFT_BEHIND[modeIn(deployment)];

            assert.deepStrictEqual(yield* whatTheRunLeft, {
              actions: left.actions,
              anonymised: left.anonymised,
              // The one person is counted in either mode: a report says what a run would change.
              counted: [1],
            });
          })
      );
    }
  );
}
