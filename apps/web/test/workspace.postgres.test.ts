/**
 * The Google Workspace projection, end to end on real PostgreSQL (spec 0008, falsifiers 4 and 5): the job reads a
 * deterministic directory fixture, records a report with exact counts and typed issues, makes no mutation call, queues
 * nothing and logs no address in a dry-run; in write mode a plan of 20 removals is queued and applied as statements of
 * state, and one of 21 is refused before any removal. The adapters' own gates are in `workspaceAdapters.test.ts`.
 */
import { assert, layer } from "@effect/vitest";
import {
  AggregateLocks,
  CompanyEmail,
  CurrentPrincipal,
  Job,
  Outbox,
  WorkspaceAssignments,
  WorkspaceJob,
  WorkspaceModeSetting,
  WorkspaceReports,
  WorkspaceWriter,
  requestWorkspaceReport,
  Transactor,
} from "@vektorprogrammet/domain";
import type {
  JobRun,
  WorkspaceChange,
  WorkspaceDirectory,
  WorkspaceFacts,
  WorkspaceMode,
  WorkspaceReport,
  AuditLog,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Ref,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { AccountDelivery } from "../src/server/accountDelivery";
import { workspaceSyncRunner } from "../src/server/jobRunners";
import { dispatchTick } from "../src/server/jobs";
import { MessageSender } from "../src/server/senders";
import { webCryptoLayer } from "../src/server/webCrypto";
import { workspaceDirectoryLayer } from "../src/server/workspace";
import { deliverPending } from "./support/deliveryLive";
import { ADMIN, adminOf } from "./support/principals";
import { rowsIn } from "./support/rowCount";
import { workspaceDatabase } from "./support/workspaceDatabase";
import {
  directoryOver,
  emptyDirectory,
  refusingWriter,
  seedWorld,
  writerOver,
} from "./support/workspaceWorld";
import type { DirectoryState } from "./support/workspaceWorld";

/** 02:30 in Oslo on 2026-10-27 (winter time): the nightly window is open and the semester is Høst 2026. */
const NIGHT = DateTime.makeUnsafe("2026-10-27T01:30:00Z");

const live = workspaceDatabase.pipe(Layer.provideMerge(webCryptoLayer));

const reset = Effect.gen(function* reset() {
  const sql = yield* SqlClient;

  yield* sql`truncate membership, account, team, person, field_of_study, department, outbox, job_run, workspace_report restart identity cascade`;
});

/**
 * What the Workspace runner's commit needs from its Layer, besides the principal and the transaction that the scheduler
 * provides. The directory is read in `prepare`, outside the transaction: a port of another system (spec 0020).
 */
type RunnerServices =
  | AggregateLocks
  | AuditLog
  | JobRun.JobRuns
  | Outbox
  | WorkspaceAssignments
  | WorkspaceFacts
  | SecureRandom.SecureRandom
  | WorkspaceReports;

/** Fixture approval exercises the automatic schedule without approving production. */
const approvedWorkspaceSync = Job.make({
  ...WorkspaceJob.workspaceSync,
  name: "workspaceSync",
  schedule: { ...WorkspaceJob.workspaceSync.schedule, status: "approved" },
});

const tick = dispatchTick<"workspaceSync", RunnerServices, WorkspaceDirectory>(
  [approvedWorkspaceSync],
  { workspaceSync: workspaceSyncRunner },
  { at: NIGHT, only: ["workspaceSync"] }
);

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

const twoMemberWorld = Effect.gen(function* twoMemberWorld() {
  yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
  yield* reset;
  yield* seedWorld({ members: 2, teams: 1 });

  return yield* Ref.make(worldOfStrays(0));
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

/** Midnight UTC on 2026-10-27, before the nightly window: only a requested report is due. */
const EARLY = DateTime.makeUnsafe("2026-10-27T00:00:00Z");

/** A world of one member and one team, and `principal`'s request for a report: a `request:` row that waits for a tick. */
const requestAs = (principal: typeof ADMIN) =>
  Effect.gen(function* requestedReport() {
    yield* TestClock.setTime(DateTime.toEpochMillis(EARLY));
    yield* reset;
    yield* seedWorld({ members: 1, teams: 1 });

    return yield* (yield* Transactor).run(
      requestWorkspaceReport.pipe(
        Effect.provideService(CurrentPrincipal, principal)
      )
    );
  });

/** The tick that takes the waiting request, in `mode` over a directory with `strays` extra members; what the writer was asked. */
const runRequested = (mode: WorkspaceMode, strays: number) =>
  Effect.gen(function* tickOfRequest() {
    const directory = yield* Ref.make(worldOfStrays(strays));
    const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);

    yield* dispatchTick<"workspaceSync", RunnerServices, WorkspaceDirectory>(
      [WorkspaceJob.workspaceSync],
      { workspaceSync: workspaceSyncRunner },
      { at: EARLY, only: ["workspaceSync"] }
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          directoryOver(directory),
          writerOver(directory, asked),
          Layer.succeed(WorkspaceModeSetting)(mode)
        )
      )
    );

    return asked;
  });

layer(live, { excludeTestServices: true })(
  "the Workspace projection on PostgreSQL",
  (it) => {
    it.layer(TestClock.layer())((layerTest) => {
      layerTest.effect(
        "twenty same-instant report requests in 100 fresh rounds each get distinct durable periods",
        () =>
          Effect.gen(function* concurrentRequests() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            const sql = yield* SqlClient;
            const transactor = yield* Transactor;

            for (const round of Arr.range(1, 100)) {
              yield* sql`delete from job_run where job = 'workspaceSync'`;

              const exits = yield* Effect.forEach(
                Arr.range(1, 20),
                () =>
                  Effect.exit(
                    transactor.run(
                      requestWorkspaceReport.pipe(
                        Effect.provideService(CurrentPrincipal, ADMIN)
                      )
                    )
                  ),
                { concurrency: "unbounded" }
              );

              const failures = Arr.flatMap(exits, (exit) =>
                Exit.isFailure(exit) ? [Cause.pretty(exit.cause)] : []
              );

              const periods = Arr.flatMap(exits, (exit) =>
                Exit.isSuccess(exit) ? [exit.value.period] : []
              );

              assert.deepStrictEqual(
                failures,
                [],
                `round ${round}: ${Arr.join(failures, "\n")}`
              );
              assert.strictEqual(new Set(periods).size, 20, `round ${round}`);

              const [row] = yield* sql<{
                readonly n: number;
              }>`select count(*)::int as n from job_run where job = 'workspaceSync'`;

              assert.strictEqual(row?.n, 20, `round ${round}`);
            }
          }),
        { timeout: 120_000 }
      );

      layerTest.effect(
        "negative control: an identical nonce cannot be reported as a second successful request",
        () =>
          Effect.gen(function* collision() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            const transactor = yield* Transactor;

            const fixedRandom = SecureRandom.make(
              (size) => new Uint8Array(size)
            );

            const request = transactor
              .run(
                requestWorkspaceReport.pipe(
                  Effect.provideService(CurrentPrincipal, ADMIN)
                )
              )
              .pipe(
                Effect.provideService(SecureRandom.SecureRandom, fixedRandom)
              );

            yield* request;
            const second = yield* Effect.exit(request);
            assert.isTrue(Exit.hasDies(second));
          })
      );
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
              departmentLists: 1,
              departmentMembers: 6,
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
            // Negative control: the same logger detects an address if a faulty log includes it.
            yield* Effect.logInfo("probe@vektorprogrammet.no").pipe(
              Effect.provide(logs)
            );
            assert.isTrue(
              Arr.some(lines, (line) => line.includes("vektorprogrammet.no"))
            );
          })
      );

      layerTest.effect(
        "RULE-039/049: active memberships in two teams produce one entry per person in the department list",
        () =>
          Effect.gen(function* departmentMembers() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            yield* seedWorld({ members: 1, teams: 2 });
            const sql = yield* SqlClient;

            const people = yield* sql<{
              readonly id: number;
            }>`select id from person order by id`;

            const teams = yield* sql<{
              readonly id: number;
            }>`select id from team order by id`;

            yield* sql`insert into membership (person_id, team_id, position_id, leader, start_term, start_year, end_term, end_year) values (${people[0]?.id}, ${teams[1]?.id}, 2, false, 'HOST'::semester_term, 2026, 'HOST'::semester_term, 2026)`;

            const directory = yield* Ref.make<DirectoryState>({
              accounts: [],
              groups: {},
            });

            yield* runIn("dry-run", directory, refusingWriter);
            const report = yield* latest;
            assert.strictEqual(report.departmentLists.length, 1);
            assert.deepStrictEqual(
              Arr.map(
                report.departmentLists[0]?.members ?? [],
                (member) => member.personId
              ),
              Arr.map(people, (person) => person.id)
            );
            assert.strictEqual(report.counts.departmentMembers, 2);
            assert.strictEqual(report.groups[1]?.desired.length, 2);
          })
      );

      layerTest.effect(
        "an invalid stored company address is visible and refuses all writes rather than removing a member",
        () =>
          Effect.gen(function* invalidStoredAddress() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            yield* seedWorld({ members: 1, teams: 1 });
            const sql = yield* SqlClient;
            yield* sql`update person set company_email = 'invalid@example.org'`;
            yield* sql`update company_address set address = 'invalid@example.org' where person_id is not null`;
            const directory = yield* Ref.make(worldOfStrays(1));
            yield* runIn("write", directory, refusingWriter);
            const report = yield* latest;
            assert.strictEqual(report.status, "refused");
            assert.deepStrictEqual(
              Arr.map(report.issues, (issue) => issue._tag),
              ["InvalidCompanyAddress", "IncompleteGroupMembers"]
            );
            assert.deepStrictEqual(report.accounts, []);
            assert.strictEqual(report.groups[0]?.actual, null);
            assert.deepStrictEqual(report.groups[0]?.removals, []);
            assert.strictEqual(yield* rowsIn("outbox"), 0);

            const [person] = yield* sql<{
              readonly company_email: string;
            }>`select company_email from person`;

            assert.strictEqual(person?.company_email, "invalid@example.org");
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
        "an administrator's requested dry-run never queues writes even when write mode is enabled",
        () =>
          Effect.gen(function* requestedDryRun() {
            const request = yield* requestAs(ADMIN);
            const asked = yield* runRequested("write", 1);

            const report = yield* latest;
            assert.strictEqual(report.period, request.period);
            assert.strictEqual(report.mode, "dry-run");
            assert.strictEqual(report.counts.removals, 1);
            assert.strictEqual(yield* rowsIn("outbox"), 0);
            assert.deepStrictEqual(yield* Ref.get(asked), []);
          })
      );

      layerTest.effect(
        "a requested report's period carries no person id; the audit row names who asked",
        () =>
          Effect.gen(function* periodWithoutPerson() {
            const sql = yield* SqlClient;
            const requester = 7_354_219;
            const request = yield* requestAs(adminOf(requester));

            // The instant and the nonce are all a period says: `job_run.period` and `workspace_report.period` are
            // declared not personal, so who asked is the audit entry's to say.
            assert.match(
              request.period,
              /^request:\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
            );

            yield* runRequested("dry-run", 0);
            assert.strictEqual((yield* latest).period, request.period);

            const named = yield* sql<{
              readonly n: number;
            }>`select ((select count(*) from job_run where period like ${`%${requester}%`}) + (select count(*) from workspace_report where period like ${`%${requester}%`}))::int as n`;

            assert.strictEqual(named[0]?.n, 0);

            // Who asked is exactly one audit row of the request's transaction, keyed by the period.
            const audited = yield* sql<{
              readonly action: string;
              readonly entity: string;
              readonly entity_key: string;
              readonly person_id: number;
            }>`select action, entity, entity_key, person_id from audit_log where person_id = ${requester}`;

            assert.deepStrictEqual(audited, [
              {
                action: "workspaceReport.requested",
                entity: "WorkspaceReport",
                entity_key: request.period,
                person_id: requester,
              },
            ]);
          })
      );

      layerTest.effect(
        "switching writes on between chunks cannot turn an already opened dry-run into a write",
        () =>
          Effect.gen(function* modeChangedDuringRun() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;
            yield* seedWorld({ members: 1, teams: 41 });
            const directory = yield* emptyDirectory;
            yield* runIn("dry-run", directory, refusingWriter);
            assert.strictEqual((yield* latest).status, "running");
            yield* runIn("write", directory, refusingWriter);
            const report = yield* latest;
            assert.strictEqual(report.status, "complete");
            assert.strictEqual(report.mode, "dry-run");
            assert.strictEqual(report.counts.groups, 41);
            assert.strictEqual(yield* rowsIn("outbox"), 0);
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

            const deliver = deliverPending.pipe(
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
              Arr.filter(delivered, (row) =>
                Predicate.isTagged(row, "Delivered")
              ).length,
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
        "a generated account keeps its address when the next projection sees it in the directory",
        () =>
          Effect.gen(function* repeatedProjection() {
            const directory = yield* twoMemberWorld;
            const asked = yield* Ref.make<readonly WorkspaceChange[]>([]);
            const writer = writerOver(directory, asked);
            yield* runIn("write", directory, writer);

            const first = Option.getOrThrow(
              Arr.findFirst((yield* latest).accounts, (line) => line.generated)
            );

            yield* deliverPending.pipe(
              Effect.provide(
                Layer.mergeAll(
                  writer,
                  Layer.mock(AccountDelivery, {}),
                  Layer.mock(MessageSender, {})
                )
              )
            );
            const nextDay = DateTime.add(NIGHT, { days: 1 });
            yield* TestClock.setTime(DateTime.toEpochMillis(nextDay));
            yield* dispatchTick<
              "workspaceSync",
              RunnerServices,
              WorkspaceDirectory
            >(
              [approvedWorkspaceSync],
              { workspaceSync: workspaceSyncRunner },
              { at: nextDay, only: ["workspaceSync"] }
            ).pipe(
              Effect.provide(
                Layer.mergeAll(
                  directoryOver(directory),
                  writer,
                  Layer.succeed(WorkspaceModeSetting)("write")
                )
              )
            );

            const second = Option.getOrThrow(
              Arr.findFirst(
                (yield* latest).accounts,
                (line) => line.personId === first.personId
              )
            );

            assert.strictEqual(second.address, first.address);
            assert.isTrue(second.present);
            assert.strictEqual((yield* latest).counts.accountsToCreate, 0);
          })
      );

      layerTest.effect(
        "a failed outbox write rolls back the generated Person address",
        () =>
          Effect.gen(function* rollbackAssignment() {
            const directory = yield* twoMemberWorld;

            const result = yield* runIn(
              "write",
              directory,
              refusingWriter
            ).pipe(
              Effect.provide(
                Layer.mock(Outbox, {
                  enqueue: () => Effect.die("outbox failed"),
                })
              )
            );

            assert.strictEqual(result[0]?.periods[0]?.result, "retry");
            const sql = yield* SqlClient;

            const rows = yield* sql<{
              readonly company_email: string | null;
            }>`select company_email from person where name = 'Medlem1x2 Navn'`;

            assert.strictEqual(rows[0]?.company_email, null);
            assert.strictEqual(yield* rowsIn("outbox"), 0);
          })
      );

      layerTest.effect(
        "interrupting an assignment rolls back the Person and namespace and releases its lock",
        () =>
          Effect.gen(function* interruptedAssignment() {
            yield* twoMemberWorld;
            const sql = yield* SqlClient;

            const [person] = yield* sql<{
              readonly id: number;
            }>`select id from person where name = 'Medlem1x2 Navn'`;

            const id = person?.id ?? 0;
            const tx = yield* Transactor;
            const locks = yield* AggregateLocks;
            const assignments = yield* WorkspaceAssignments;
            const reached = yield* Deferred.make<null>();
            const hold = yield* Deferred.make<null>();

            const address = CompanyEmail.make(
              "interrupted@vektorprogrammet.no"
            );

            const work = Effect.gen(function* assign() {
              const locked = yield* locks.lock("Person", id);
              yield* assignments.assign(locked, address);
              yield* Deferred.succeed(reached, null);
              yield* Deferred.await(hold);
            });

            const fiber = yield* Effect.forkChild(tx.run(work));
            yield* Deferred.await(reached);
            yield* Fiber.interrupt(fiber);

            const [after] = yield* sql<{
              readonly company_email: string | null;
            }>`select company_email from person where id = ${id}`;

            const [claims] = yield* sql<{
              readonly n: number;
            }>`select count(*)::int as n from company_address where address = ${address}`;

            assert.strictEqual(after?.company_email, null);
            assert.strictEqual(claims?.n, 0);
            yield* tx.run(
              Effect.gen(function* retry() {
                const locked = yield* locks.lock("Person", id);
                yield* assignments.assign(locked, address);
              })
            );

            const [retried] = yield* sql<{
              readonly company_email: string | null;
            }>`select company_email from person where id = ${id}`;

            assert.strictEqual(retried?.company_email, address);
          })
      );

      layerTest.effect(
        "twenty competing assignments in 100 rounds keep one address; omitting the recheck lets all win",
        () =>
          Effect.gen(function* assignmentRace() {
            yield* reset;
            yield* seedWorld({ members: 1, teams: 1 });
            const sql = yield* SqlClient;

            const [person] = yield* sql<{
              readonly id: number;
            }>`select id from person`;

            const id = person?.id ?? 0;
            const tx = yield* Transactor;
            const locks = yield* AggregateLocks;
            const assignments = yield* WorkspaceAssignments;

            const attempts = (unsafe: boolean) =>
              Effect.forEach(
                Arr.range(0, 19),
                (index) =>
                  tx
                    .run(
                      Effect.gen(function* attempt() {
                        const locked = yield* locks.lock("Person", id);

                        const address = CompanyEmail.make(
                          index % 2 === 0
                            ? "one@vektorprogrammet.no"
                            : "two@vektorprogrammet.no"
                        );

                        yield* unsafe
                          ? sql`update person set company_email = ${address} where id = ${locked.id}`
                          : assignments.assign(locked, address);
                      })
                    )
                    .pipe(Effect.exit),
                { concurrency: "unbounded" }
              );

            for (const round of Arr.range(1, 100)) {
              yield* sql`delete from company_address where person_id = ${id}`;
              yield* sql`update person set company_email = null where id = ${id}`;
              const safe = yield* attempts(false);

              const failures = Arr.flatMap(safe, (exit) =>
                Exit.isFailure(exit) ? [exit.cause] : []
              );

              const causes = Arr.join(Arr.map(failures, Cause.pretty), "\n");
              assert.strictEqual(
                failures.length,
                10,
                `round ${round}: ${causes}`
              );
              assert.isTrue(
                Arr.every(failures, (cause) =>
                  Predicate.isTagged(Cause.squash(cause), "Conflict")
                ),
                `round ${round}: ${causes}`
              );
              yield* sql`delete from company_address where person_id = ${id}`;
              yield* sql`update person set company_email = null where id = ${id}`;
              const unsafe = yield* attempts(true);
              assert.strictEqual(
                Arr.filter(unsafe, Exit.isFailure).length,
                0,
                `negative control round ${round}`
              );
            }
          }),
        { timeout: 120_000 }
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
        "a 25-team run finishes within the declared chunk budget",
        () =>
          Effect.gen(function* resumed() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NIGHT));
            yield* reset;

            // 25 teams: the accounts chunk, then three chunks of 10, 10 and 5 teams (the job's chunk size is 10).
            yield* seedWorld({ members: 1, teams: 25 });

            const directory = yield* emptyDirectory;
            const reports = yield* runIn("dry-run", directory, refusingWriter);

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
                departmentLists: 1,
                departmentMembers: 25,
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
