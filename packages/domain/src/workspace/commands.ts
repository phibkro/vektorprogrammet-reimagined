/**
 * The Workspace projection's handlers (spec 0008). `prepareSync` is the half that reads the provider, and it runs
 * outside any transaction. `syncWorkspace` is the half that commits: it reads the facts, records the chunk in the
 * report and, in the last chunk, queues the changes. The dispatcher adds the cursor to the same transaction
 * (`JobRuns.advance`), so a chunk's rows and its cursor commit together, or neither does.
 *
 * Provider reads that fail with `WorkspaceNotConfigured` (no credentials: the operator's gate) do not fail the run:
 * the report records the desired state and the issue `ActualStateUnavailable`, so the operator can already compare
 * the expected members of every team. A provider failure does fail the attempt, and the run is retried.
 */
import {
  Array as Arr,
  Crypto,
  DateTime,
  Effect,
  Match,
  Option,
  Order,
  Predicate,
  Schema,
} from "effect";

import { requestPeriod } from "../jobs/job.ts";
import type { JobPeriod } from "../jobs/job.ts";
import { workspaceSync } from "../jobs/registry.ts";
import { JobRuns } from "../jobs/runs.ts";
import * as Commands from "../kernel/commands.ts";
import { semesterForDate } from "../organisation/semester.ts";
import type { Semester } from "../organisation/semester.ts";
import { AggregateLocks } from "../shared/aggregate.ts";
import { Outbox, OutboxMessage } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import {
  Cursor,
  WorkspaceDomain,
  WorkspaceRpc,
  createWorkspaceReport,
  syncWorkspace,
} from "./declaration.ts";
import type { DirectoryRead } from "./declaration.ts";
import {
  Issue,
  capIssue,
  changesOf,
  memberAddresses,
  planAccounts,
  planDepartmentLists,
  planGroup,
  unmanagedGroups,
} from "./plan.ts";
import type { ActualGroup, TeamFact } from "./plan.ts";
import { summarise } from "./report.ts";
import type { WorkspaceReport } from "./report.ts";
import {
  WorkspaceAssignments,
  WorkspaceDirectory,
  WorkspaceFacts,
  WorkspaceModeSetting,
  WorkspaceReports,
} from "./services.ts";
import type { WorkspaceReadFailure } from "./services.ts";

const decodeCursor = Schema.decodeUnknownEffect(Cursor);

const encodeCursor = Schema.encodeEffect(Cursor);

/** The stored form of a cursor: JSON. */
const cursorJson = (cursor: Cursor) => Effect.orDie(encodeCursor(cursor));

/** A run starts with the accounts. A stored cursor that does not decode is a defect, not a restart. */
const cursorOf = (stored: Schema.Json | null) =>
  stored === null
    ? Effect.succeed(Cursor.cases.Accounts.make({}))
    : Effect.orDie(decodeCursor(stored));

/** A removal cap that the declaration lacks refuses every removal: the safe reading of a missing limit. */
const removalCap = workspaceSync.limits.removals ?? 0;

const unavailable = (reason: string): DirectoryRead => ({
  accounts: null,
  groups: null,
  members: [],
  unavailable: reason,
});

const readAccounts = Effect.gen(function* readAccounts() {
  const directory = yield* WorkspaceDirectory;

  return {
    accounts: yield* directory.accounts,
    groups: yield* directory.groups,
    members: [],
    unavailable: null,
  } satisfies DirectoryRead;
});

const readGroups = Effect.fnUntraced(function* readGroups(
  semester: Semester,
  after: TeamFact["teamId"] | null
) {
  const directory = yield* WorkspaceDirectory;
  const facts = yield* WorkspaceFacts;

  const teams = yield* facts.teamsAfter(
    semester,
    after,
    workspaceSync.chunkSize
  );

  const members = yield* Effect.forEach(
    Arr.flatMap(teams, (team) =>
      team.groupAddress === null ? [] : [team.groupAddress]
    ),
    (group) =>
      Effect.map(directory.members(group), (found) => ({
        group,
        members: found,
      }))
  );

  return {
    accounts: null,
    groups: null,
    members,
    unavailable: null,
  } satisfies DirectoryRead;
});

/**
 * What the next chunk needs from the directory, read before its transaction opens. The accounts chunk asks for every
 * account and group address; a teams chunk asks for the members of the groups of its teams only.
 */
export const prepareSync = Effect.fnUntraced(function* prepareSync(
  stored: Schema.Json | null
) {
  const cursor = yield* cursorOf(stored);
  const semester = semesterForDate(yield* DateTime.now);

  const read: Effect.Effect<
    DirectoryRead,
    WorkspaceReadFailure,
    WorkspaceDirectory | WorkspaceFacts
  > = Match.value(cursor).pipe(
    Match.tagsExhaustive({
      Accounts: () => readAccounts,
      Groups: ({ after }) => readGroups(semester, after),
    })
  );

  return yield* read.pipe(
    Effect.catchTag("WorkspaceNotConfigured", ({ reason }) =>
      Effect.succeed(unavailable(reason))
    )
  );
});

const unavailableIssues = (directory: DirectoryRead): readonly Issue[] =>
  directory.unavailable === null
    ? []
    : [
        Issue.cases.ActualStateUnavailable.make({
          reason: directory.unavailable,
        }),
      ];

/** What one team adds to the report. */
interface GroupPart {
  readonly lines: WorkspaceReport["groups"];
  readonly issues: readonly Issue[];
}

/** One team's line, or the issue that it has no group address to put a line under. */
const groupPart = (
  team: TeamFact,
  accounts: WorkspaceReport["accounts"],
  directory: DirectoryRead
): GroupPart => {
  const address = team.groupAddress;

  if (address === null) {
    return {
      issues: [Issue.cases.NoGroupAddress.make({ teamId: team.teamId })],
      lines: [],
    };
  }

  const knownPeople = new Set(Arr.map(accounts, (account) => account.personId));

  const incomplete = Arr.some(
    team.members,
    (personId) => !knownPeople.has(personId)
  );

  const read: ActualGroup = incomplete
    ? null
    : Option.match(
        Arr.findFirst(directory.members, (entry) => entry.group === address),
        {
          onNone: () => null,
          onSome: (entry) => entry.members,
        }
      );

  return {
    issues: incomplete
      ? [Issue.cases.IncompleteGroupMembers.make({ teamId: team.teamId })]
      : [],
    lines: [planGroup(team, address, memberAddresses(team, accounts), read)],
  };
};

const requireReport = Effect.fnUntraced(function* requireReport(
  period: JobPeriod
) {
  const reports = yield* WorkspaceReports;

  return yield* Option.match(yield* reports.read(period), {
    onNone: () =>
      Effect.die(`the report of ${period} was not opened by its first chunk`),
    onSome: Effect.succeed,
  });
});

/** Assign generated addresses and queue their provider intents in the same transaction. */
const assignGenerated = Effect.fnUntraced(function* assignGenerated(
  report: WorkspaceReport
) {
  const generated = Arr.filter(report.accounts, (account) => account.generated);

  if (generated.length === 0) {
    return yield* Effect.void;
  }

  // All writers claim namespace keys in address order, after the Person locks in id order.

  const locked = yield* (yield* AggregateLocks).lockAll(
    "Person",
    Arr.map(generated, (account) => account.personId)
  );

  const assignments = yield* WorkspaceAssignments;

  const tokens = new Map(
    Arr.map(locked, (token) => [token.id, token] as const)
  );

  const byAddress = Order.mapInput(
    Order.String,
    (account: WorkspaceReport["accounts"][number]) => account.address
  );

  for (const account of Arr.sort(generated, byAddress)) {
    const person = tokens.get(account.personId);

    if (person === undefined) {
      return yield* Effect.die(
        "the planned Workspace address has no locked person"
      );
    }

    yield* assignments.assign(person, account.address);
  }

  return yield* Effect.void;
});

/** The last chunk enforces the cap and queues permitted changes with the report. */
const complete = Effect.fnUntraced(function* complete(period: JobPeriod) {
  const reports = yield* WorkspaceReports;
  const report = yield* requireReport(period);
  const mode = yield* WorkspaceModeSetting;
  const over = capIssue(report.groups, removalCap);

  if (Option.isSome(over)) {
    yield* reports.append(period, { issues: [over.value] });

    const counts = summarise({
      ...report,
      issues: [...report.issues, over.value],
    });

    yield* reports.complete(period, "refused", counts);

    return counts;
  }

  const counts = summarise(report);

  const unresolved = Arr.some(
    report.issues,
    (issue) =>
      Predicate.isTagged(issue, "InvalidCompanyAddress") ||
      Predicate.isTagged(issue, "NoCompanyAddress") ||
      Predicate.isTagged(issue, "IncompleteGroupMembers")
  );

  if (report.mode === "write" && mode === "write" && unresolved) {
    yield* reports.complete(period, "refused", counts);

    return { ...counts, queued: 0 };
  }

  const changes =
    report.actual === "read" && report.mode === "write" && mode === "write"
      ? changesOf(report.accounts, report.groups)
      : [];

  if (Arr.isReadonlyArrayNonEmpty(changes)) {
    yield* assignGenerated(report);
    yield* (yield* Outbox).enqueue(
      Arr.map(changes, (change) =>
        OutboxMessage.cases.WorkspaceChange.make({ change })
      )
    );
  }

  yield* reports.complete(period, "complete", counts);

  return { ...counts, queued: changes.length };
});

/** The first chunk: every account the projection wants, and what the directory holds beyond what the system names. */
const accountsChunk = Effect.fnUntraced(function* accountsChunk(
  period: JobPeriod,
  semester: Semester,
  directory: DirectoryRead
) {
  const facts = yield* WorkspaceFacts;
  const reports = yield* WorkspaceReports;
  const people = yield* facts.people(semester);
  const stored = yield* facts.storedAddresses;
  const configured = yield* facts.configuredGroupAddresses;
  const groups = new Set<string>([...configured, ...(directory.groups ?? [])]);
  const plan = planAccounts(people, stored, directory.accounts, groups);

  const departmentLists = planDepartmentLists(
    yield* facts.departments,
    yield* facts.departmentEngagements(semester),
    plan.lines
  );

  const configuredMode = yield* WorkspaceModeSetting;

  yield* reports.open({
    actual: directory.unavailable === null ? "read" : "unavailable",
    mode: period.startsWith("request:") ? "dry-run" : configuredMode,
    period,
    semester,
  });
  yield* reports.append(period, {
    accounts: plan.lines,
    departmentLists,
    issues: [...plan.issues, ...unavailableIssues(directory)],
    unmanaged: {
      accounts: plan.unmanaged,
      groups: unmanagedGroups(directory.groups, configured),
    },
  });

  return {
    counts: { accounts: plan.lines.length, issues: plan.issues.length },
    cursor: yield* cursorJson(Cursor.cases.Groups.make({ after: null })),
    done: false,
  };
});

/** A chunk of teams: their groups against what the directory holds, then the cursor, or the end of the run. */
const groupsChunk = Effect.fnUntraced(function* groupsChunk(
  period: JobPeriod,
  semester: Semester,
  after: TeamFact["teamId"] | null,
  directory: DirectoryRead
) {
  const facts = yield* WorkspaceFacts;
  const reports = yield* WorkspaceReports;

  const teams = yield* facts.teamsAfter(
    semester,
    after,
    workspaceSync.chunkSize
  );

  const { accounts } = yield* requireReport(period);
  const parts = Arr.map(teams, (team) => groupPart(team, accounts, directory));

  yield* reports.append(period, {
    groups: Arr.flatMap(parts, (part) => part.lines),
    issues: Arr.flatMap(parts, (part) => part.issues),
  });

  const last = Arr.last(teams);

  if (Option.isSome(last) && teams.length === workspaceSync.chunkSize) {
    return {
      counts: { teams: teams.length },
      cursor: yield* cursorJson(
        Cursor.cases.Groups.make({ after: last.value.teamId })
      ),
      done: false,
    };
  }

  return {
    counts: yield* complete(period),
    cursor: yield* cursorJson(Cursor.cases.Groups.make({ after })),
    done: true,
  };
});

export const WorkspaceHandlers = WorkspaceRpc.toLayer({
  /**
   * An administrator asks for a dry-run: a request row, which the next tick takes. No provider is called and nothing
   * else is written. The period names the instant and who asked.
   */
  createWorkspaceReport: WorkspaceDomain.handle(createWorkspaceReport, {
    resource: () => Effect.succeed({}),
    run: (_payload, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const now = yield* DateTime.now;

        const nonce = yield* Effect.orDie(
          (yield* Crypto.Crypto).randomUUIDv4()
        );

        const period = requestPeriod(
          `${DateTime.toEpochMillis(now)}-${Predicate.isTagged(principal, "Person") ? principal.personId : principal._tag}-${nonce}`
        );

        const inserted = yield* (yield* JobRuns).request(
          "workspaceSync",
          period
        );

        if (!inserted) {
          return yield* Effect.die(
            "a newly generated Workspace request period already exists"
          );
        }

        return { period };
      }),
  }),
  /**
   * One chunk of the projection (the job `workspaceSync`). Not a staff write: the principal is the job, and the
   * report and the job's cursor are its own record, so no audit entry is written.
   */
  syncWorkspace: WorkspaceDomain.handle(syncWorkspace, {
    resource: () => Effect.succeed({}),
    run: ({ cursor, directory, period }) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const position = yield* cursorOf(cursor);
        const semester = semesterForDate(yield* DateTime.now);

        return yield* Match.value(position).pipe(
          Match.tagsExhaustive({
            Accounts: () => accountsChunk(period, semester, directory),
            Groups: ({ after }) =>
              groupsChunk(period, semester, after, directory),
          })
        );
      }),
  }),
});

/** The Workspace commands behind the in-process client; see `Commands.inProcess`. */
export const withWorkspace = Commands.inProcess(
  WorkspaceRpc,
  WorkspaceHandlers
);

/** An administrator's request for a run, as the Integrations page sends it: a row that the next tick takes. */
export const requestWorkspaceReport = withWorkspace((client) =>
  client.createWorkspaceReport()
);
