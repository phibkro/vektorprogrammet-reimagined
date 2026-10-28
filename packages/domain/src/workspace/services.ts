/**
 * The Workspace projection's ports (spec 0008). The domain states what it needs; `apps/web` builds the directory and
 * the writer by deployment, and `packages/db` reads the facts and keeps the report.
 *
 * The provider directory and writer are separate services: a dry-run never calls the writer. The report is persisted
 * locally, but generated Person addresses are assigned only in write mode. No call to Google exists on this branch:
 * without operator-held credentials the directory fails `WorkspaceNotConfigured` and the report says so.
 */
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { JobPeriod } from "../jobs/job.ts";
import type { Counts } from "../jobs/runs.ts";
import type { Semester } from "../organisation/semester.ts";
import type { Locked } from "../shared/aggregate.ts";
import type { AlreadyExists, Conflict } from "../shared/errors.ts";
import type { TeamId } from "../shared/ids.ts";
import type {
  IntegrationTypeId,
  InTransaction,
  IntegrationPort,
} from "../shared/transaction.ts";
import type { WorkspaceChange } from "./change.ts";
import type { CompanyEmail } from "./companyEmail.ts";
import type {
  AccountLine,
  DepartmentEngagement,
  DepartmentFact,
  DepartmentList,
  GroupLine,
  Issue,
  PersonFact,
  TeamFact,
  Unmanaged,
} from "./plan.ts";
import type {
  ActualState,
  ReportStatus,
  WorkspaceMode,
  WorkspaceReport,
} from "./report.ts";

/** Nothing is provisioned to ask the directory (no credentials): the operator's gate. The same call never succeeds before then. */
export class WorkspaceNotConfigured extends Schema.TaggedError<
  WorkspaceNotConfigured,
  { readonly brand: unique symbol }
>()("WorkspaceNotConfigured", { reason: Schema.String }) {}

/** The provider failed. The same call may succeed later, so the run is retried. */
export class WorkspaceProviderFailed extends Schema.TaggedError<
  WorkspaceProviderFailed,
  { readonly brand: unique symbol }
>()("WorkspaceProviderFailed", { reason: Schema.String }) {}

/** The directory was asked to change while writes are off (`WORKSPACE_MODE` is not `write`). */
export class WorkspaceWriteRefused extends Schema.TaggedError<
  WorkspaceWriteRefused,
  { readonly brand: unique symbol }
>()("WorkspaceWriteRefused", { reason: Schema.String }) {}

export type WorkspaceReadFailure =
  | WorkspaceNotConfigured
  | WorkspaceProviderFailed;

/**
 * The Google Workspace directory, read only. Addresses are lower case. An integration port (ADR 0015, section 10):
 * `Transactor.run` refuses a program that requires it.
 */
export class WorkspaceDirectory
  extends Context.Service<
    WorkspaceDirectory,
    {
      /** Every company account of the domain. */
      readonly accounts: Effect.Effect<
        readonly CompanyEmail[],
        WorkspaceReadFailure
      >;
      /** Every group address of the domain. */
      readonly groups: Effect.Effect<
        readonly CompanyEmail[],
        WorkspaceReadFailure
      >;
      /** The members of one group, or `"missing"` when the directory has no such group. */
      readonly members: (
        group: CompanyEmail
      ) => Effect.Effect<
        readonly CompanyEmail[] | "missing",
        WorkspaceReadFailure
      >;
    }
  >()("@vektorprogrammet/domain/workspace/WorkspaceDirectory")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationTypeId;
}

/**
 * The only way to change the directory. Each change is a statement of state, so applying one twice is harmless. An
 * integration port (ADR 0015, section 10).
 */
export class WorkspaceWriter
  extends Context.Service<
    WorkspaceWriter,
    {
      readonly apply: (
        change: WorkspaceChange
      ) => Effect.Effect<void, WorkspaceWriteRefused | WorkspaceProviderFailed>;
    }
  >()("@vektorprogrammet/domain/workspace/WorkspaceWriter")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationTypeId;
}

/**
 * Whether the projection may queue changes. `dry-run` unless the deployment says `write`; reading it is the whole of
 * the gate, so approving writes is one value that the operator sets.
 */
export const WorkspaceModeSetting = Context.Reference<WorkspaceMode>(
  "@vektorprogrammet/domain/workspace/Mode",
  { defaultValue: () => "dry-run" }
);

/** The projection's inputs, read the way a display reads: no lock, no write. `packages/db` implements it. */
export class WorkspaceFacts extends Context.Service<
  WorkspaceFacts,
  {
    /** People with an active engagement in `semester` and an Active account. The current source is team memberships. */
    readonly people: (
      semester: Semester
    ) => Effect.Effect<readonly PersonFact[]>;
    /** Active departments and active person/department engagements. Spec 0011 can add placements to the same contract. */
    readonly departments: Effect.Effect<readonly DepartmentFact[]>;
    readonly departmentEngagements: (
      semester: Semester
    ) => Effect.Effect<readonly DepartmentEngagement[]>;
    /** Every company address that any person has (the addresses that RULE-058 must not give out again). */
    readonly storedAddresses: Effect.Effect<ReadonlySet<string>>;
    /** Every group address that a team has configured, whatever the team's state. */
    readonly configuredGroupAddresses: Effect.Effect<ReadonlySet<string>>;
    /** The next `limit` active teams after `after` (`null`: from the first), each with the people active in it. */
    readonly teamsAfter: (
      semester: Semester,
      after: TeamId | null,
      limit: number
    ) => Effect.Effect<readonly TeamFact[]>;
  }
>()("@vektorprogrammet/domain/workspace/WorkspaceFacts") {}

/** A generated address is assigned only when a write-mode report is committed. */
export class WorkspaceAssignments extends Context.Service<
  WorkspaceAssignments,
  {
    readonly assign: (
      locked: Locked<"Person">,
      address: CompanyEmail
    ) => Effect.Effect<void, AlreadyExists | Conflict, InTransaction>;
  }
>()("@vektorprogrammet/domain/workspace/WorkspaceAssignments") {}

/** What one chunk adds to a report. */
export interface ReportPart {
  readonly accounts?: readonly AccountLine[];
  readonly departmentLists?: readonly DepartmentList[];
  readonly groups?: readonly GroupLine[];
  readonly issues?: readonly Issue[];
  readonly unmanaged?: Unmanaged;
}

/** The report of a run, kept in the chunks' own transactions (`packages/db`). */
export class WorkspaceReports extends Context.Service<
  WorkspaceReports,
  {
    /** Opens the report of `period`; a chunk of an earlier attempt may have opened it already, so this is idempotent. */
    readonly open: (input: {
      readonly period: JobPeriod;
      readonly mode: WorkspaceMode;
      readonly semester: Semester;
      readonly actual: ActualState;
    }) => Effect.Effect<void, never, InTransaction>;
    readonly append: (
      period: JobPeriod,
      part: ReportPart
    ) => Effect.Effect<void, never, InTransaction>;
    readonly complete: (
      period: JobPeriod,
      status: Exclude<ReportStatus, "running">,
      counts: Counts
    ) => Effect.Effect<void, never, InTransaction>;
    readonly read: (
      period: JobPeriod
    ) => Effect.Effect<Option.Option<WorkspaceReport>>;
    /** The newest report: what the Integrations page shows. A read. */
    readonly latest: Effect.Effect<Option.Option<WorkspaceReport>>;
  }
>()("@vektorprogrammet/domain/workspace/WorkspaceReports") {}
