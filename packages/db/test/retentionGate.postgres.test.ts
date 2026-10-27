/**
 * Spec 0007b R4, falsifier 2: the retention gate in the database package. What the nightly run does with the rows it
 * selects is fixed by the layer that provides it (`RetentionRun`), and a program cannot change it:
 *
 * - `JobDatabaseLive` with `Apply` changes rows, audited as `retention.ran`;
 * - `JobDatabaseLive` with `ReportOnly`, and every ordinary layer (`DatabaseLive`), only counts the same selections and
 *   writes nothing, audited as `retention.reported`;
 * - the report runs as a role that can only SELECT, which no write survives, and the run that changes rows does not.
 *
 * Each side has the check that it must pass and the check of the other side, which it must fail: that is its negative
 * control, so a layer that applied where it should report (or the reverse) fails a test here.
 */
import { assert, layer } from "@effect/vitest";
import {
  PersonalDataDeclaration,
  afterDuration,
} from "@vektorprogrammet/domain";
import type {
  RetentionMode,
  RetentionOutcome,
  RetentionRun,
} from "@vektorprogrammet/domain";
import { eq } from "drizzle-orm";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Layer,
  Record as Rec,
} from "effect";
import type { SqlClient as SqlClientService } from "effect/sql/SqlClient";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { JobDatabaseLive, schema, transactional } from "../src/index.ts";
import {
  Drizzle,
  postgresDatabase,
  postgresJobDatabase,
} from "./support/database.ts";
import {
  ReadOnlyDatabaseUrl,
  assertPermissionDenied,
  readOnlyRole,
} from "./support/readOnlyRole.ts";
import { at, nightlyOutcome, runRetention } from "./support/retentionRun.ts";
import { snapshot } from "./support/snapshot.ts";
import { world } from "./support/teamsWorld.ts";

const { years } = PersonalDataDeclaration;

const T0 = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

/** Three years on: long past the year that the person core is kept for after the last activity. */
const LATER = afterDuration(T0, years(3));

type Snapshot = Readonly<Record<string, string>>;

/** What one run over a due person did, as the tables show it. */
interface Observed {
  readonly after: Snapshot;
  readonly anonymised: boolean;
  readonly before: Snapshot;
  readonly outcome: RetentionOutcome;
}

/** A person whose only activity is their creation, at `T0`: due at `LATER`. */
const duePerson = Effect.fnUntraced(function* duePerson(tag: string) {
  const sql = yield* SqlClient;
  const { person } = yield* world(tag);

  yield* sql`update person set created_at = ${DateTime.toDateUtc(T0)} where id = ${person.id}`;

  return person.id;
});

const isAnonymised = Effect.fnUntraced(function* isAnonymised(id: number) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly anonymised: boolean;
  }>`select anonymised_at is not null as anonymised from person where id = ${id}`;

  return row?.anonymised ?? false;
});

/** The run of the layer's `RetentionRun` at `LATER`, in a transaction as the job runs it. */
const nightly = transactional(nightlyOutcome(LATER)).pipe(Effect.orDie);

/** A due person, one run through the layer, and what it did to the person and to every table. */
const observeRun = Effect.fnUntraced(function* observeRun(tag: string) {
  const id = yield* duePerson(tag);
  const before = yield* snapshot;
  const outcome = yield* nightly;
  const after = yield* snapshot;

  return {
    after,
    anonymised: yield* isAnonymised(id),
    before,
    outcome,
  } satisfies Observed;
});

const changedTables = (before: Snapshot, after: Snapshot): readonly string[] =>
  Arr.filter(Rec.keys(after), (table) => after[table] !== before[table]);

/** What is wrong with a run as a report: empty when it counted what is due and changed nothing. */
const reportProblems = ({
  after,
  anonymised,
  before,
  outcome,
}: Observed): string[] => [
  ...(outcome.mode === "ReportOnly" ? [] : [`the mode is ${outcome.mode}`]),
  ...((outcome.counts.person ?? 0) > 0 ? [] : ["it counted no person"]),
  ...(anonymised ? ["it anonymised the person"] : []),
  ...Arr.map(
    changedTables(before, after),
    (table) => `it changed the table ${table}`
  ),
];

/** What is wrong with a run as a run that changes rows: empty when it changed what it counted. */
const applyProblems = ({
  after,
  anonymised,
  before,
  outcome,
}: Observed): string[] => [
  ...(outcome.mode === "Apply" ? [] : [`the mode is ${outcome.mode}`]),
  ...((outcome.counts.person ?? 0) > 0 ? [] : ["it changed no person"]),
  ...(anonymised ? [] : ["it left the person as they were"]),
  ...(changedTables(before, after).length > 0 ? [] : ["it changed no table"]),
];

/** The audit rows of the retention job, with the action each one names. */
const retentionAudit = Effect.gen(function* retentionAudit() {
  const db = yield* Drizzle;

  return yield* db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.systemJob, "retention"));
});

/** The job over a due person, and the person afterwards, and the audit rows that it wrote. */
const observeJob = Effect.fnUntraced(function* observeJob(tag: string) {
  const id = yield* duePerson(tag);
  yield* at(LATER);
  const outcome = yield* runRetention;

  return {
    anonymised: yield* isAnonymised(id),
    audit: yield* retentionAudit,
    outcome,
  };
});

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0007b R4: the layer that applies",
  (outer) => {
    outer.effect(
      "an Apply run anonymises the person that is due, counts them, and changes the tables",
      () =>
        Effect.gen(function* applies() {
          assert.deepStrictEqual(
            applyProblems(yield* observeRun("applied")),
            []
          );
        })
    );

    outer.effect(
      "negative control: the check of a report fails for a run that applies, for each thing it changed",
      () =>
        Effect.gen(function* controlsReport() {
          const problems = reportProblems(yield* observeRun("applied-control"));

          assert.includeMembers(problems, [
            "the mode is Apply",
            "it anonymised the person",
            "it changed the table person",
          ]);
        })
    );

    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "the job audits an Apply run as retention.ran, with the counts of the run, and nothing as retention.reported",
        () =>
          Effect.gen(function* auditsApply() {
            const { anonymised, audit, outcome } =
              yield* observeJob("applied-job");

            assert.strictEqual(outcome.mode, "Apply");
            assert.isTrue(anonymised);

            assert.deepStrictEqual(
              Arr.map(audit, (row) => row.action),
              ["retention.ran"]
            );

            assert.deepStrictEqual(audit[0]?.counts, outcome.counts);
          })
      );
    });
  }
);

/**
 * The report side, over each layer that must report: the job layer that was given `ReportOnly`, and the ordinary layer
 * (`DatabaseLive`) that a request and every other program builds, which reports and cannot apply.
 */
for (const [name, database] of [
  ["the job layer that reports", postgresJobDatabase("ReportOnly")],
  ["the ordinary database layer", postgresDatabase()],
] as const) {
  layer(database, { excludeTestServices: true })(
    `spec 0007b R4: ${name}`,
    (outer) => {
      outer.effect(
        "a run counts the person that is due, anonymises nobody, and changes no table",
        () =>
          Effect.gen(function* reports() {
            assert.deepStrictEqual(
              reportProblems(yield* observeRun("reported")),
              []
            );
          })
      );

      outer.effect(
        "negative control: the check of a run that applies fails for a report, for each thing that it did not do",
        () =>
          Effect.gen(function* controlsApply() {
            const problems = applyProblems(
              yield* observeRun("reported-control")
            );

            assert.includeMembers(problems, [
              "the mode is ReportOnly",
              "it left the person as they were",
              "it changed no table",
            ]);
          })
      );

      outer.layer(TestClock.layer())((it) => {
        it.effect(
          "the job audits a report as retention.reported, never as retention.ran, and the person is as they were",
          () =>
            Effect.gen(function* auditsReport() {
              const { anonymised, audit, outcome } =
                yield* observeJob("reported-job");

              assert.strictEqual(outcome.mode, "ReportOnly");
              assert.isFalse(anonymised);
              assert.isAbove(outcome.counts.person ?? 0, 0);

              assert.deepStrictEqual(
                Arr.map(audit, (row) => row.action),
                ["retention.reported"]
              );

              assert.deepStrictEqual(audit[0]?.counts, outcome.counts);
            })
        );
      });
    }
  );
}

/**
 * `program` with the services of `JobDatabaseLive` connected as the SELECT-only role of the database, its retention in
 * `retention`: what the run did, as an `Exit`. The layers are built fresh (`Layer.fresh`): the test's own layer has built
 * the layers that they share (`Drizzle`) over the owner's connection, and a build with the test's memo map would reuse
 * that one, so that the run would be the owner's and every pass here would prove nothing.
 */
const asReader = <A, E>(
  retention: RetentionMode,
  program: Effect.Effect<A, E, RetentionRun | SqlClientService>
) =>
  Effect.gen(function* reading() {
    const url = yield* ReadOnlyDatabaseUrl;

    const context = yield* Layer.build(
      Layer.fresh(JobDatabaseLive({ maxConnections: 2, retention, url }))
    );

    return yield* Effect.exit(Effect.provideContext(program, context));
  });

layer(readOnlyRole.pipe(Layer.provideMerge(postgresJobDatabase("Apply"))), {
  excludeTestServices: true,
})("spec 0007b R4: the report as a role that can only read", (it) => {
  it.effect(
    "a report succeeds as the SELECT-only role and counts the person that is due: it wrote nothing, for any write is refused",
    () =>
      Effect.gen(function* readsOnly() {
        yield* duePerson("reader");
        const exit = yield* asReader("ReportOnly", nightly);

        assert.isTrue(
          Exit.isSuccess(exit),
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        );

        if (Exit.isSuccess(exit)) {
          assert.strictEqual(exit.value.mode, "ReportOnly");
          assert.isAbove(exit.value.counts.person ?? 0, 0);
        }
      })
  );

  it.effect(
    "negative control: the run that changes rows is refused by the same role, so that the report's success is the report's own",
    () =>
      Effect.gen(function* refused() {
        yield* duePerson("writer");
        assertPermissionDenied(yield* asReader("Apply", nightly));
      })
  );
});
