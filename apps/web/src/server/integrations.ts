import {
  OutboxReports,
  WorkspaceModeSetting,
  WorkspaceReports,
  requestWorkspaceReport,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option } from "effect";

/**
 * The newest persisted Workspace report and the state of the outbox (spec 0008b: the messages that are not delivered,
 * each retrying or failed, with the class of the last error and never the message), with dates encoded for the
 * server-function boundary. This is a read only.
 */
export const integrationsView = Effect.gen(function* integrationsView() {
  const mode = yield* WorkspaceModeSetting;
  const reports = yield* WorkspaceReports;
  const latest = yield* reports.latest;
  const outbox = yield* (yield* OutboxReports).overview;

  return {
    mode,
    outbox: {
      counts: outbox.counts,
      open: Arr.map(outbox.open, (row) => ({
        ...row,
        nextAttemptAt: DateTime.formatIso(row.nextAttemptAt),
        queuedAt:
          row.queuedAt === null ? null : DateTime.formatIso(row.queuedAt),
      })),
    },
    report: Option.match(latest, {
      onNone: () => null,
      onSome: (report) => ({
        ...report,
        completedAt:
          report.completedAt === null
            ? null
            : DateTime.formatIso(report.completedAt),
        startedAt: DateTime.formatIso(report.startedAt),
      }),
    }),
  };
});

/** Enqueue an explicitly dry-run report; the next scheduled tick processes it. */
export const requestWorkspaceReportProgram = Effect.as(
  requestWorkspaceReport,
  "Rapporten er bestilt og kjøres ved neste planlagte kjøring."
);
