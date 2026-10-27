import {
  WorkspaceDirectory,
  WorkspaceModeSetting,
  WorkspaceNotConfigured,
  WorkspaceWriteRefused,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import type { WorkspaceMode } from "@vektorprogrammet/domain";
/**
 * The Google Workspace directory and writer, chosen once by deployment and mode (spec 0008). No call to Google
 * exists on this branch: reading the real directory needs credentials that the operator holds, so production gets a
 * directory that says so (`WorkspaceNotConfigured`: the report then records the desired state and the issue), and
 * local and Preview get an empty one. The follow-up that adds the Google adapter replaces the production branch of
 * `workspaceDirectoryLayer` and nothing else.
 *
 * Writes are a separate service so that a program that only reads has no mutation in its type. `WORKSPACE_MODE` is
 * `dry-run` unless it says `write`; in `dry-run` the writer refuses every change in every deployment, so a
 * `WorkspaceChange` that was somehow queued is retried and dead-lettered by the outbox and never applied. A `write`
 * outside production captures the change (kind only in the log); a `write` in production refuses until the adapter
 * and its credentials exist, so the operator's one switch cannot reach Google by itself.
 */
import { Effect, Layer, Match } from "effect";

import type { Deployment } from "./deployment";
import type { WorkerEnv } from "./env";

export interface WorkspaceConfig {
  readonly deployment: Deployment;
  readonly mode: WorkspaceMode;
}

/** `write` only when the deployment says exactly that; anything else, or nothing, is a dry-run. */
export const workspaceConfigFromEnv = (
  deployment: Deployment,
  env: Pick<WorkerEnv, "WORKSPACE_MODE">
): WorkspaceConfig => ({
  deployment,
  mode: env.WORKSPACE_MODE === "write" ? "write" : "dry-run",
});

const notConfigured = Effect.fail(
  new WorkspaceNotConfigured({
    reason:
      "Google Workspace credentials are not provisioned (the operator's gate, spec 0008)",
  })
);

/** A directory with nothing in it: no group exists, so every desired group and member is an addition. */
const emptyDirectory = WorkspaceDirectory.of({
  accounts: Effect.succeed([]),
  groups: Effect.succeed([]),
  members: () => Effect.succeed("missing"),
});

/** The directory that production has until the Google adapter and its credentials exist. */
const unconfiguredDirectory = WorkspaceDirectory.of({
  accounts: notConfigured,
  groups: notConfigured,
  members: () => notConfigured,
});

export const workspaceDirectoryLayer = (
  config: WorkspaceConfig
): Layer.Layer<WorkspaceDirectory> =>
  Layer.succeed(WorkspaceDirectory)(
    config.deployment === "production" ? unconfiguredDirectory : emptyDirectory
  );

const refusing = (reason: string) =>
  WorkspaceWriter.of({
    apply: () => Effect.fail(new WorkspaceWriteRefused({ reason })),
  });

/** Records that a change was asked for (its kind only: an address is personal data) and changes nothing. */
const capturing = WorkspaceWriter.of({
  apply: (change) =>
    Effect.logInfo(
      "workspace change captured (non-production deployment)"
    ).pipe(Effect.annotateLogs({ kind: change._tag })),
});

export const workspaceWriterLayer = (
  config: WorkspaceConfig
): Layer.Layer<WorkspaceWriter> =>
  Layer.succeed(WorkspaceWriter)(
    Match.value(config).pipe(
      Match.when({ mode: "dry-run" }, () =>
        refusing("Workspace writes are off: WORKSPACE_MODE is not write")
      ),
      Match.when({ deployment: "production" }, () =>
        refusing(
          "Workspace writes need the Google adapter and its credentials, which the operator provisions (spec 0008)"
        )
      ),
      Match.orElse(() => capturing)
    )
  );

/** What the mode setting of the domain reads: the one gate of the projection's queueing. */
export const workspaceModeLayer = (
  config: WorkspaceConfig
): Layer.Layer<never> => Layer.succeed(WorkspaceModeSetting)(config.mode);
