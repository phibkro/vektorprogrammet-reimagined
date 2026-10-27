import {
  WorkspaceModeSetting,
  WorkspaceReports,
  requestWorkspaceReport,
} from "@vektorprogrammet/domain";
import { DateTime, Effect, Option } from "effect";

/** The newest persisted report, with dates encoded for the server-function boundary. This is a read only. */
export const integrationsView = Effect.gen(function* integrationsView() {
  const mode = yield* WorkspaceModeSetting;
  const reports = yield* WorkspaceReports;
  const latest = yield* reports.latest;

  return {
    mode,
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
