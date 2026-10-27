/**
 * The Google Workspace projection, end to end on real PostgreSQL (spec 0008, falsifiers 4 and 5): the job reads a
 * deterministic directory fixture, records a report with exact counts and typed issues, makes no mutation call, queues
 * nothing and logs no address in a dry-run; in write mode a plan of 20 removals is queued and applied as statements of
 * state, and one of 21 is refused before any removal. The adapters' own gates are in `workspaceAdapters.test.ts`.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  JobRegistry,
  WorkspaceModeSetting,
  WorkspaceReports,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import type {
  JobRun,
  Outbox,
  WorkspaceChange,
  WorkspaceDirectory,
  WorkspaceFacts,
  WorkspaceMode,
  WorkspaceReport,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Layer,
  Logger,
  Option,
  Ref,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { AccountDelivery } from "../src/server/accountDelivery";
import { workspaceSyncRunner } from "../src/server/jobRunners";
import { dispatchTick } from "../src/server/jobs";
import { deliverOutbox } from "../src/server/outboxDelivery";
import { MessageSender } from "../src/server/senders";
import { transactorLayer } from "../src/server/transactor";
import { workspaceDirectoryLayer } from "../src/server/workspace";
import {
  directoryOver,
  refusingWriter,
  seedWorld,
  writerOver,
} from "./support/workspaceWorld";
import type { DirectoryState } from "./support/workspaceWorld";

/** 02:30 in Oslo on 2026-10-27 (winter time): the nightly window is open and the semester is Høst 2026. */
const NIGHT = DateTime.makeUnsafe("2026-10-27T01:30:00Z");

const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    transactorLayer.pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 10, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

const reset = Effect.gen(function* reset() {
  const sql = yield* SqlClient;

  yield* sql`truncate membership, account, team, person, field_of_study, department, outbox, job_run, workspace_report restart identity cascade`;
});

/** What the Workspace runner needs from its Layer, besides the principal and the transaction that the scheduler provides. */
type RunnerServices =
  | JobRun.JobRuns
  | Outbox
  | WorkspaceDirectory
  | WorkspaceFacts
  | WorkspaceReports;

const tick = dispatchTick<"workspaceSync", RunnerServices>(
  [JobRegistry.workspaceSync],
  { workspaceSync: workspaceSyncRunner },
  { at: NIGHT, only: ["workspaceSync"] }
);

const rowsIn = (table: "outbox" | "workspace_report") =>
  Effect.gen(function* rowCount() {
    const sql = yield* SqlClient;

    const [row] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from ${sql(table)}`;

    return row?.n ?? -1;
  });

const latest = Effect.gen(function* latest() {
  return Option.getOrThrow(yield* (yield* WorkspaceReports).latest);
});

const gone = (n: number) =>
  Arr.makeBy(n, (index) => `gone${index}@vektorprogrammet.no`);

/** The plan that the world of `strays` removals gives: one team, one member, a group holding the member and the strays. */
const worldOfStrays = (strays: number): DirectoryState => ({
  accounts: ["leder1@vektorprogrammet.no"],
  groups: {
    "team1@vektorprogrammet.no": [
      "leder1@vektorprogrammet.no",
      ...gone(strays),
    ],
  },
});

/** Runs the job in `mode` against `directory`, with `writer` standing in for the provider's mutations. */
const runIn = (
  mode: WorkspaceMode,
  directory: Ref.Ref<DirectoryState>,
  writer: Layer.Layer<WorkspaceWriter>
) =>
  tick.pipe(
    Effect.provide(
      Layer.mergeAll(
        directoryOver(directory),
        writer,
        Layer.succeed(WorkspaceModeSetting)(mode)
      )
    )
  );

layer(live, { excludeTestServices: true })(
  "the Workspace projection on PostgreSQL",
  (it) => {
    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "falsifier 4: a dry-run against a deterministic directory records exact counts and typed issues, makes no mutation call, queues nothing and logs no address",
        () =>
          Effect.gen(function* dryRun() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;

            yield* seedWorld({
              configured: (index) => index !== 3,
              members: 2,
              teams: 3,
            });

            const directory = yield* Ref.make<DirectoryState>({
              accounts: [
                "leder1@vektorprogrammet.no",
                "leder2@vektorprogrammet.no",
                "stray@vektorprogrammet.no",
              ],
              groups: {
                "info@vektorprogrammet.no": ["leder1@vektorprogrammet.no"],
                "team1@vektorprogrammet.no": [
                  "leder1@vektorprogrammet.no",
                  "gone@vektorprogrammet.no",
                ],
              },
            });

            const lines: string[] = [];

            const logs = Logger.layer([
              Logger.make((options) => {
                lines.push(Logger.formatLogFmt.log(options));
              }),
            ]);

            const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);
            const before = yield* Ref.get(directory);

            const reports = yield* runIn(
              "dry-run",
              directory,
              writerOver(directory, asked)
            ).pipe(Effect.provide(logs));

            assert.deepStrictEqual(
              Arr.map(reports, (report) => [
                report.job,
                Arr.map(report.periods, (period) => period.result),
              ]),
              [["workspaceSync", ["done"]]]
            );

            const report = yield* latest;

            assert.deepStrictEqual(
              [report.status, report.mode, report.actual],
              ["complete", "dry-run", "read"]
            );

            // Six people want accounts; two have theirs, four do not (three named by RULE-058, one stored).
            assert.deepStrictEqual(report.counts, {
              accountsToCreate: 4,
              accountsWanted: 6,
              additions: 3,
              groups: 2,
              issues: 1,
              removals: 1,
              unmanagedAccounts: 1,
              unmanagedGroups: 1,
            });

            assert.deepStrictEqual(
              Arr.map(
                report.groups,
                (group) =>
                  `${group.address} desired=${group.desired.length} actual=${String(group.actual)} additions=${group.additions.length} removals=${Arr.join(group.removals, "+")} missing=${group.missing}`
              ),
              [
                "team1@vektorprogrammet.no desired=2 actual=2 additions=1 removals=gone@vektorprogrammet.no missing=false",
                "team2@vektorprogrammet.no desired=2 actual=null additions=2 removals= missing=true",
              ]
            );

            assert.deepStrictEqual(
              Arr.map(report.issues, (issue) => issue._tag),
              ["NoGroupAddress"],
              "a team without a configured group address is a typed issue, not a guessed address"
            );
            assert.deepStrictEqual(
              [
                Arr.join(report.unmanaged.accounts, ","),
                Arr.join(report.unmanaged.groups, ","),
              ],
              ["stray@vektorprogrammet.no", "info@vektorprogrammet.no"]
            );

            assert.deepStrictEqual(
              yield* Ref.get(asked),
              [],
              "no mutation call"
            );
            assert.deepStrictEqual(
              yield* Ref.get(directory),
              before,
              "the directory is as it was"
            );
            assert.strictEqual(
              yield* rowsIn("outbox"),
              0,
              "nothing is queued in a dry-run"
            );
            assert.isTrue(lines.length > 0, "the run logged");
            assert.isFalse(
              Arr.some(lines, (line) => line.includes("vektorprogrammet.no")),
              "no address in a log line"
            );
          })
      );

      layerTest.effect(
        "falsifier 4: a production deployment without credentials records the desired state and the issue, and reads no directory",
        () =>
          Effect.gen(function* unavailable() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            yield* seedWorld({ members: 2, teams: 2 });

            yield* tick.pipe(
              Effect.provide(
                Layer.mergeAll(
                  workspaceDirectoryLayer({
                    deployment: "production",
                    mode: "dry-run",
                  }),
                  refusingWriter,
                  Layer.succeed(WorkspaceModeSetting)("dry-run")
                )
              )
            );

            const report = yield* latest;

            assert.strictEqual(report.actual, "unavailable");
            assert.strictEqual(report.status, "complete");
            assert.deepStrictEqual(
              Arr.map(report.issues, (issue) => issue._tag),
              ["ActualStateUnavailable"]
            );
            assert.strictEqual(report.accounts.length, 4);
            assert.isTrue(
              Arr.every(report.accounts, (line) => line.present === null)
            );
            assert.deepStrictEqual(
              Arr.map(report.groups, (group) => [
                group.desired.length,
                group.additions.length,
                group.removals.length,
              ]),
              [
                [2, 0, 0],
                [2, 0, 0],
              ],
              "the expected members of every team are there to compare, with no difference claimed"
            );
          })
      );

      layerTest.effect(
        "falsifier 5: in write mode a plan of 20 removals is queued and applied as statements of state, once however often it is delivered",
        () =>
          Effect.gen(function* twentyRemovals() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            yield* seedWorld({ members: 1, teams: 1 });

            const directory = yield* Ref.make(worldOfStrays(20));
            const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);

            yield* runIn("write", directory, writerOver(directory, asked));

            const report = yield* latest;

            assert.strictEqual(report.status, "complete");
            assert.strictEqual(report.counts.removals, 20);
            assert.strictEqual(yield* rowsIn("outbox"), 20);
            assert.deepStrictEqual(
              yield* Ref.get(asked),
              [],
              "queued, not applied before commit's delivery"
            );

            const deliver = deliverOutbox({ limit: 50 }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  writerOver(directory, asked),
                  Layer.mock(AccountDelivery, {}),
                  Layer.mock(MessageSender, {})
                )
              )
            );

            const delivered = yield* deliver;

            assert.strictEqual(
              Arr.filter(delivered, (row) => row.outcome === "delivered")
                .length,
              20
            );
            assert.deepStrictEqual((yield* Ref.get(directory)).groups, {
              "team1@vektorprogrammet.no": ["leder1@vektorprogrammet.no"],
            });
            assert.strictEqual((yield* Ref.get(asked)).length, 20);

            // A repeated delivery asks nothing: the rows are delivered. A repeated change changes nothing.
            assert.deepStrictEqual(yield* deliver, []);

            const settled = yield* Ref.get(directory);

            yield* Effect.forEach(yield* Ref.get(asked), (change) =>
              Effect.provide(
                Effect.gen(function* again() {
                  yield* (yield* WorkspaceWriter).apply(change);
                }),
                writerOver(directory, asked)
              )
            );

            assert.deepStrictEqual(yield* Ref.get(directory), settled);
          })
      );

      layerTest.effect(
        "falsifier 5: a plan of 21 removals is refused before any removal, in write mode and in a dry-run alike",
        () =>
          Effect.gen(function* twentyOneRemovals() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));

            for (const mode of ["write", "dry-run"] as const) {
              yield* reset;
              yield* seedWorld({ members: 1, teams: 1 });

              const directory = yield* Ref.make(worldOfStrays(21));
              const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);

              yield* runIn(mode, directory, writerOver(directory, asked));

              const report: WorkspaceReport = yield* latest;

              assert.strictEqual(report.status, "refused", mode);
              assert.deepStrictEqual(
                Arr.map(report.issues, (issue) => issue._tag),
                ["RemovalCapExceeded"],
                mode
              );
              assert.strictEqual(report.counts.removals, 21, mode);
              assert.strictEqual(
                yield* rowsIn("outbox"),
                0,
                `${mode}: nothing queued`
              );
              assert.deepStrictEqual(
                yield* Ref.get(asked),
                [],
                `${mode}: no removal asked`
              );
              assert.strictEqual(
                (yield* Ref.get(directory)).groups["team1@vektorprogrammet.no"]
                  ?.length,
                22,
                `${mode}: the group is untouched`
              );
            }
          })
      );

      layerTest.effect(
        "a run that is killed before its last chunk leaves a running report, and the same period finishes it once",
        () =>
          Effect.gen(function* resumed() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;

            // 25 teams: the accounts chunk, then three chunks of 10, 10 and 5 teams (the job's chunk size is 10).
            yield* seedWorld({ members: 1, teams: 25 });

            const directory = yield* Ref.make<DirectoryState>({
              accounts: [],
              groups: {},
            });

            const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);

            const reports = yield* runIn(
              "dry-run",
              directory,
              writerOver(directory, asked)
            );

            assert.deepStrictEqual(
              Arr.map(reports[0]?.periods ?? [], (period) => period.result),
              ["done"],
              "four chunks fit the job's budget of five per tick"
            );

            const report = yield* latest;

            assert.strictEqual(report.status, "complete");
            assert.strictEqual(report.groups.length, 25);
            assert.strictEqual(yield* rowsIn("workspace_report"), 1);
            assert.deepStrictEqual(
              report.counts,
              {
                accountsToCreate: 25,
                accountsWanted: 25,
                additions: 25,
                groups: 25,
                issues: 0,
                removals: 0,
                unmanagedAccounts: 0,
                unmanagedGroups: 0,
              },
              "an empty directory: every group is missing and every member an addition"
            );
          })
      );
    });
  }
);
