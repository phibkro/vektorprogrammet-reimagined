/**
 * The Workspace projection's repositories (spec 0008).
 *
 * `WorkspaceFacts` reads the projection inputs without a lock or a write and is registered with the SELECT-only
 * role test. `WorkspaceAssignments` assigns generated Person addresses through their locks when a write report
 * completes. `WorkspaceReports` writes one report chunk at a time under the period's lease.
 * Stored sections are decoded on read: a row that violates the domain schema is a defect, not an empty report.
 */
import {
  CompanyEmail,
  Conflict,
  DepartmentId,
  InTransaction,
  PersonId,
  TeamId,
  WorkspaceAssignments,
  WorkspaceFacts,
  WorkspacePlan,
  WorkspaceReport,
  WorkspaceReports,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import type {
  Locked,
  ReportPart,
  Semester,
  Job,
  JobRun,
} from "@vektorprogrammet/domain";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
} from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { verified } from "../live.ts";
import {
  account,
  department,
  membership,
  person,
  team,
  workspaceReport,
} from "../schema.ts";
import { claimPersonAddress } from "./companyAddresses.ts";

const PersonRow = Schema.Struct({
  companyAddress: Schema.NullOr(Schema.String),
  name: Schema.String,
  personId: PersonId,
});

const TeamRow = Schema.Struct({
  groupAddress: Schema.NullOr(CompanyEmail),
  name: Schema.String,
  teamId: TeamId,
});

const MemberRow = Schema.Struct({ personId: PersonId, teamId: TeamId });

const DepartmentRow = Schema.Struct({
  departmentId: DepartmentId,
  name: Schema.String,
});

const EngagementRow = Schema.Struct({
  departmentId: DepartmentId,
  personId: PersonId,
});

/** A membership that is active in the semester of `ordinal`, in a team that is active, of a person whose Account is Active. */
const activeIn = (ordinal: number) =>
  and(
    lte(membership.startOrdinal, ordinal),
    gte(membership.endOrdinal, ordinal),
    eq(team.active, true),
    eq(account.state, "Active")
  );

const addressSet = (
  rows: readonly { readonly address: string | null }[],
  decode: (value: readonly string[]) => Effect.Effect<readonly string[]>
) =>
  Effect.map(
    decode(
      Arr.flatMap(rows, (row) => (row.address === null ? [] : [row.address]))
    ),
    (addresses) => new Set<string>(addresses)
  );

export const WorkspaceFactsLive = Layer.effect(
  WorkspaceFacts,
  Effect.gen(function* WorkspaceFactsLive() {
    const db = yield* Drizzle;
    const decodePeople = decodeWith(Schema.Array(PersonRow));
    const decodeTeams = decodeWith(Schema.Array(TeamRow));
    const decodeMembers = decodeWith(Schema.Array(MemberRow));
    const decodeAddresses = decodeWith(Schema.Array(CompanyEmail));
    const decodeStoredAddresses = decodeWith(Schema.Array(Schema.String));

    const decodeDepartments = decodeWith(Schema.Array(DepartmentRow));
    const decodeEngagements = decodeWith(Schema.Array(EngagementRow));

    const departments = db
      .select({ departmentId: department.id, name: department.name })
      .from(department)
      .where(eq(department.active, true))
      .orderBy(asc(department.id))
      .pipe(Effect.orDie, Effect.flatMap(decodeDepartments));

    // A placement can contribute the same (department, person) fact in spec 0011; the projection's input stays unchanged.
    const departmentEngagements = Effect.fn(
      "WorkspaceFacts.departmentEngagements"
    )(function* departmentEngagements(semester: Semester) {
      const rows = yield* db
        .selectDistinct({
          departmentId: team.departmentId,
          personId: membership.personId,
        })
        .from(membership)
        .innerJoin(team, eq(team.id, membership.teamId))
        .innerJoin(department, eq(department.id, team.departmentId))
        .innerJoin(account, eq(account.personId, membership.personId))
        .where(
          and(activeIn(semesterOrdinal(semester)), eq(department.active, true))
        )
        .orderBy(asc(team.departmentId), asc(membership.personId))
        .pipe(Effect.orDie);

      return yield* decodeEngagements(rows);
    });

    const people = Effect.fn("WorkspaceFacts.people")(function* people(
      semester: Semester
    ) {
      const ordinal = semesterOrdinal(semester);

      const rows = yield* db
        .select({
          companyAddress: person.companyEmail,
          name: person.name,
          personId: person.id,
        })
        .from(person)
        .where(
          exists(
            db
              .select({ personId: membership.personId })
              .from(membership)
              .innerJoin(team, eq(team.id, membership.teamId))
              .innerJoin(account, eq(account.personId, membership.personId))
              .where(and(eq(membership.personId, person.id), activeIn(ordinal)))
          )
        )
        .orderBy(asc(person.id))
        .pipe(Effect.orDie);

      return yield* decodePeople(rows);
    });

    const storedAddresses = Effect.gen(function* storedAddresses() {
      const rows = yield* db
        .select({ address: person.companyEmail })
        .from(person)
        .where(isNotNull(person.companyEmail))
        .pipe(Effect.orDie);

      return yield* addressSet(rows, decodeStoredAddresses);
    }).pipe(Effect.withSpan("WorkspaceFacts.storedAddresses"));

    const configuredGroupAddresses = Effect.gen(
      function* configuredGroupAddresses() {
        const rows = yield* db
          .select({ address: team.groupEmail })
          .from(team)
          .where(isNotNull(team.groupEmail))
          .pipe(Effect.orDie);

        return yield* addressSet(rows, decodeAddresses);
      }
    ).pipe(Effect.withSpan("WorkspaceFacts.configuredGroupAddresses"));

    const teamsAfter = Effect.fn("WorkspaceFacts.teamsAfter")(
      function* teamsAfter(
        semester: Semester,
        after: TeamId | null,
        limit: number
      ) {
        const ordinal = semesterOrdinal(semester);

        const teams = yield* decodeTeams(
          yield* db
            .select({
              groupAddress: team.groupEmail,
              name: team.name,
              teamId: team.id,
            })
            .from(team)
            .where(
              and(
                eq(team.active, true),
                after === null ? undefined : gt(team.id, after)
              )
            )
            .orderBy(asc(team.id))
            .limit(limit)
            .pipe(Effect.orDie)
        );

        const members = yield* decodeMembers(
          yield* db
            .selectDistinct({
              personId: membership.personId,
              teamId: membership.teamId,
            })
            .from(membership)
            .innerJoin(team, eq(team.id, membership.teamId))
            .innerJoin(account, eq(account.personId, membership.personId))
            .where(
              and(
                inArray(
                  membership.teamId,
                  Arr.map(teams, (row) => row.teamId)
                ),
                activeIn(ordinal)
              )
            )
            .orderBy(asc(membership.personId))
            .pipe(Effect.orDie)
        );

        return Arr.map(teams, (row) => ({
          groupAddress: row.groupAddress,
          members: Arr.flatMap(members, (member) =>
            member.teamId === row.teamId ? [member.personId] : []
          ),
          name: row.name,
          teamId: row.teamId,
        }));
      }
    );

    return WorkspaceFacts.of({
      configuredGroupAddresses,
      departmentEngagements,
      departments,
      people,
      storedAddresses,
      teamsAfter,
    });
  })
);

/** One stored row of `workspace_report`, as the domain's record: the semester and the instants are assembled here. */
const toRecord = (row: typeof workspaceReport.$inferSelect) => ({
  accounts: row.accounts,
  actual: row.actual,
  completedAt:
    row.completedAt === null ? null : DateTime.fromDateUnsafe(row.completedAt),
  counts: row.counts,
  departmentLists: row.departmentLists,
  groups: row.groups,
  issues: row.issues,
  mode: row.mode,
  period: row.period,
  semester: { term: row.semesterTerm, year: row.semesterYear },
  startedAt: DateTime.fromDateUnsafe(row.startedAt),
  status: row.status,
  unmanaged: row.unmanaged,
});

/** Assign a planned address under the Person lock, so a later projection keeps the same account. */
export const WorkspaceAssignmentsLive = Layer.effect(
  WorkspaceAssignments,
  Effect.gen(function* WorkspaceAssignmentsLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;
    const decodeEmail = decodeWith(Schema.NullOr(Schema.String));

    const assign = Effect.fn("WorkspaceAssignments.assign")(function* assign(
      locked: Locked<"Person">,
      address: CompanyEmail
    ) {
      yield* InTransaction;
      yield* aggregates.assertHeld(roots.Person, locked);

      const [row] = yield* db
        .select({ email: person.companyEmail })
        .from(person)
        .where(eq(person.id, locked.id))
        .pipe(Effect.orDie);

      if (row === undefined) {
        return yield* Effect.die("the locked person is missing");
      }

      const existing = yield* decodeEmail(row.email);

      if (existing === address) {
        return yield* Effect.void;
      }

      if (existing !== null) {
        return yield* new Conflict({
          entity: "Person",
          key: String(locked.id),
          message: "Personens Vektor-epost ble endret under synkroniseringen.",
        });
      }

      yield* claimPersonAddress(aggregates, locked, address);
      yield* aggregates
        .updateRoot(locked, roots.Person, { companyEmail: address })
        .pipe(Effect.catch((error) => classifySqlFailure(error, address)));

      return yield* Effect.void;
    });

    return yield* verified(
      "WorkspaceAssignments",
      WorkspaceAssignments.of({ assign })
    );
  })
);

export const WorkspaceReportsLive = Layer.effect(
  WorkspaceReports,
  Effect.gen(function* WorkspaceReportsLive() {
    const db = yield* Drizzle;
    const decodeRecord = decodeFirstOption(decodeWith(WorkspaceReport));
    const decodeAccounts = decodeWith(Schema.Array(WorkspacePlan.AccountLine));
    const decodeGroups = decodeWith(Schema.Array(WorkspacePlan.GroupLine));
    const decodeIssues = decodeWith(Schema.Array(WorkspacePlan.Issue));

    const encodeAccounts = Schema.encodeEffect(
      Schema.Array(WorkspacePlan.AccountLine)
    );

    const encodeDepartmentLists = Schema.encodeEffect(
      Schema.Array(WorkspacePlan.DepartmentList)
    );

    const encodeGroups = Schema.encodeEffect(
      Schema.Array(WorkspacePlan.GroupLine)
    );

    const encodeIssues = Schema.encodeEffect(Schema.Array(WorkspacePlan.Issue));
    const encodeUnmanaged = Schema.encodeEffect(WorkspacePlan.Unmanaged);

    const open = Effect.fn("WorkspaceReports.open")(function* open(input: {
      readonly period: Job.JobPeriod;
      readonly mode: WorkspaceReport["mode"];
      readonly semester: Semester;
      readonly actual: WorkspaceReport["actual"];
    }) {
      yield* InTransaction;

      yield* db
        .insert(workspaceReport)
        .values({
          actual: input.actual,
          mode: input.mode,
          period: input.period,
          semesterTerm: input.semester.term,
          semesterYear: input.semester.year,
          startedAt: DateTime.toDateUtc(yield* DateTime.now),
          status: "running",
        })
        .onConflictDoNothing()
        .pipe(Effect.orDie);
    });

    /** The report row of `period`, with the sections that a chunk adds to. Not finding it is a broken invariant. */
    const sections = Effect.fnUntraced(function* sections(
      period: Job.JobPeriod
    ) {
      const [row] = yield* db
        .select({
          accounts: workspaceReport.accounts,
          groups: workspaceReport.groups,
          issues: workspaceReport.issues,
        })
        .from(workspaceReport)
        .where(eq(workspaceReport.period, period))
        .pipe(Effect.orDie);

      if (row === undefined) {
        return yield* Effect.die(`no report is open for ${period}`);
      }

      return row;
    });

    const append = Effect.fn("WorkspaceReports.append")(function* append(
      period: Job.JobPeriod,
      part: ReportPart
    ) {
      yield* InTransaction;
      const row = yield* sections(period);

      const unmanaged =
        part.unmanaged === undefined
          ? undefined
          : yield* Effect.orDie(encodeUnmanaged(part.unmanaged));

      yield* db
        .update(workspaceReport)
        .set({
          accounts: yield* Effect.orDie(
            encodeAccounts([
              ...(yield* decodeAccounts(row.accounts)),
              ...(part.accounts ?? []),
            ])
          ),
          departmentLists:
            part.departmentLists === undefined
              ? undefined
              : yield* Effect.orDie(
                  encodeDepartmentLists(part.departmentLists)
                ),
          groups: yield* Effect.orDie(
            encodeGroups([
              ...(yield* decodeGroups(row.groups)),
              ...(part.groups ?? []),
            ])
          ),
          issues: yield* Effect.orDie(
            encodeIssues([
              ...(yield* decodeIssues(row.issues)),
              ...(part.issues ?? []),
            ])
          ),
          unmanaged,
        })
        .where(eq(workspaceReport.period, period))
        .pipe(Effect.orDie);
    });

    const complete = Effect.fn("WorkspaceReports.complete")(function* complete(
      period: Job.JobPeriod,
      status: Exclude<WorkspaceReport["status"], "running">,
      counts: JobRun.Counts
    ) {
      yield* InTransaction;

      yield* db
        .update(workspaceReport)
        .set({
          completedAt: DateTime.toDateUtc(yield* DateTime.now),
          counts,
          status,
        })
        .where(eq(workspaceReport.period, period))
        .pipe(Effect.orDie);
    });

    const read = Effect.fn("WorkspaceReports.read")(function* read(
      period: Job.JobPeriod
    ) {
      return yield* decodeRecord(
        Arr.map(
          yield* db
            .select()
            .from(workspaceReport)
            .where(eq(workspaceReport.period, period))
            .pipe(Effect.orDie),
          toRecord
        )
      );
    });

    const latest = Effect.gen(function* latest() {
      return yield* decodeRecord(
        Arr.map(
          yield* db
            .select()
            .from(workspaceReport)
            .orderBy(desc(workspaceReport.id))
            .limit(1)
            .pipe(Effect.orDie),
          toRecord
        )
      );
    }).pipe(Effect.withSpan("WorkspaceReports.latest"));

    return yield* verified(
      "WorkspaceReports",
      WorkspaceReports.of({ append, complete, latest, open, read })
    );
  })
);
