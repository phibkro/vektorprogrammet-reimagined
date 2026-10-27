/**
 * The record of one projection run (spec 0008): what the system wants, what the directory held, and the difference,
 * so an administrator can compare it with the expected members of every team before writes are ever switched on.
 * It is written by `syncWorkspace` chunk by chunk and read by the Integrations page. It holds people as ids and
 * addresses and the counts that the logs may show; a log never holds an address.
 */
import { Array as Arr, Schema } from "effect";

import { JobPeriod } from "../jobs/job.ts";
import { Counts } from "../jobs/runs.ts";
import { Semester } from "../organisation/semester.ts";
import {
  AccountLine,
  DepartmentList,
  GroupLine,
  Issue,
  Unmanaged,
  removalCount,
} from "./plan.ts";

/** `dry-run` records the plan and nothing else; `write` also queues the changes (the operator's switch). */
export const WorkspaceMode = Schema.Literals(["dry-run", "write"]);

export type WorkspaceMode = typeof WorkspaceMode.Type;

/** `running`: chunks remain. `complete`: the report is recorded. `refused`: the cap or unresolved member addresses prevent writes. */
export const ReportStatus = Schema.Literals(["running", "complete", "refused"]);

export type ReportStatus = typeof ReportStatus.Type;

/** `read`: the directory answered. `unavailable`: nothing is provisioned to ask it, so only the desired state is shown. */
export const ActualState = Schema.Literals(["read", "unavailable"]);

export type ActualState = typeof ActualState.Type;

export const WorkspaceReport = Schema.Struct({
  accounts: Schema.Array(AccountLine),
  actual: ActualState,
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
  counts: Counts,
  departmentLists: Schema.Array(DepartmentList),
  groups: Schema.Array(GroupLine),
  issues: Schema.Array(Issue),
  mode: WorkspaceMode,
  period: JobPeriod,
  semester: Semester,
  startedAt: Schema.DateTimeUtc,
  status: ReportStatus,
  unmanaged: Unmanaged,
});

export type WorkspaceReport = typeof WorkspaceReport.Type;

/** The integer counts of a report, the only part of it that a log or a job's record may show. */
export const summarise = (
  report: Pick<
    WorkspaceReport,
    "accounts" | "departmentLists" | "groups" | "issues" | "unmanaged"
  >
): Counts => ({
  accountsToCreate: Arr.filter(
    report.accounts,
    (line) => line.present === false
  ).length,
  accountsWanted: report.accounts.length,
  additions: Arr.reduce(
    report.groups,
    0,
    (total, group) => total + group.additions.length
  ),
  departmentLists: report.departmentLists.length,
  departmentMembers: Arr.reduce(
    report.departmentLists,
    0,
    (total, list) => total + list.members.length
  ),
  groups: report.groups.length,
  issues: report.issues.length,
  removals: removalCount(report.groups),
  unmanagedAccounts: report.unmanaged.accounts.length,
  unmanagedGroups: report.unmanaged.groups.length,
});
