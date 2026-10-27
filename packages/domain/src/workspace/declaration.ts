/**
 * The Google Workspace projection as data (spec 0008): two commands and one read. An administrator asks for a run
 * (`createWorkspaceReport`: it writes a request and calls no provider), and the job `workspaceSync` does it in chunks
 * (`syncWorkspace`: provider reads happen before the transaction, and the chunk's rows commit with its cursor).
 * `syncWorkspace` is granted to `System("workspaceSync")` alone, so the job passes through `authorize` like every
 * command. The handlers are in `commands.ts`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { JobPeriod } from "../jobs/job.ts";
import { Counts } from "../jobs/runs.ts";
import {
  Info,
  grant,
  info,
  make as declareDomain,
  system,
} from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { TeamId } from "../shared/ids.ts";
import { CompanyEmail } from "./companyEmail.ts";

/** Where a run is: the accounts come first (one chunk), then the teams in id order, a chunk at a time. */
export const Cursor = Schema.TaggedUnion({
  Accounts: {},
  Groups: { after: Schema.NullOr(TeamId) },
});

export type Cursor = typeof Cursor.Type;

/** What the chunk's `prepare` read from the directory, outside any transaction. */
export const DirectoryRead = Schema.Struct({
  accounts: Schema.NullOr(Schema.Array(CompanyEmail)),
  groups: Schema.NullOr(Schema.Array(CompanyEmail)),
  members: Schema.Array(
    Schema.Struct({
      group: CompanyEmail,
      members: Schema.Union([
        Schema.Array(CompanyEmail),
        Schema.Literal("missing"),
      ]),
    })
  ),
  /** Why the directory was not read (nothing is provisioned to ask it); `null` when it was. */
  unavailable: Schema.NullOr(Schema.String),
});

export type DirectoryRead = typeof DirectoryRead.Type;

export const createWorkspaceReport = Rpc.make("createWorkspaceReport", {
  error: DomainErrorSchema,
  success: Schema.Struct({ period: JobPeriod }),
}).annotate(
  Info,
  info({
    method: "create",
    note: "Writes a request that the next tick takes; it calls no provider. The report appears when the run is done.",
    replaces: ["RULE-243", "RULE-244"],
    resource: "WorkspaceReport",
    summary: "Ask for a Google Workspace dry-run.",
  })
);

export const syncWorkspace = Rpc.make("syncWorkspace", {
  error: DomainErrorSchema,
  payload: {
    cursor: Schema.NullOr(Schema.Json),
    directory: DirectoryRead,
    period: JobPeriod,
  },
  success: Schema.Struct({
    counts: Counts,
    cursor: Schema.Json,
    done: Schema.Boolean,
  }),
}).annotate(
  Info,
  info({
    job: "workspaceSync",
    method: ":sync",
    note: "One chunk: records the accounts, or the next teams' groups, and the cursor. In write mode its last chunk queues the changes, unless the removals are over the cap.",
    replaces: [
      "RULE-039",
      "RULE-049",
      "RULE-225",
      "RULE-242",
      "RULE-243",
      "RULE-244",
      "RULE-245",
      "RULE-246",
    ],
    resource: "WorkspaceReport",
    summary:
      "Compare the Google Workspace groups and accounts with the active memberships and record the changes.",
  })
);

export const WorkspaceRpc = RpcGroup.make(createWorkspaceReport, syncWorkspace);

export const WorkspaceDomain = declareDomain({
  commands: WorkspaceRpc,
  grants: [grant([system("workspaceSync")], ["syncWorkspace"], "all")],
  name: "workspace",
  reads: {
    viewIntegrations: {
      replaces: [],
      summary:
        "See the integrations: the Google Workspace report and whether writes are on.",
    },
  },
  title: "Integrations",
});
