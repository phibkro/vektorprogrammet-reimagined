/**
 * The runner of every registered job (spec 0008). The table is typed over exactly the names of the registry
 * (`RegisteredJob`), so a job that is declared and has no runner does not type-check, and a runner without a
 * declaration does not either. Each runner is the job's own System command, run by the scheduler as that principal
 * through `authorize`; the registry adds the schedule, the budget and the record of runs, and no second way to write.
 */
import {
  JobRegistry,
  alumniConsentJob,
  endingSoonJob,
  prepareSync,
  retentionJob,
  semesterJob,
  semesterLabel,
  withWorkspace,
} from "@vektorprogrammet/domain";
import type {
  CurrentPrincipal,
  DomainError,
  InTransaction,
  JobRun,
  SiteOrigin,
  WorkspaceDirectory,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import { Effect, Match } from "effect";
import type { Crypto } from "effect";

import type { AccountDelivery } from "./accountDelivery";
import type { Runner } from "./jobs";
import { OutboxPublisher } from "./outboxPublisher";
import { withOutbox } from "./outboxSweep";
import type { DatabaseServices } from "./runtime";
import type { MessageSender } from "./senders";

/** Everything the runners (and so a tick) need besides the transaction runner, which the scheduler itself holds. */
export type TickServices =
  | DatabaseServices
  | AccountDelivery
  | MessageSender
  | OutboxPublisher
  | WorkspaceDirectory
  | WorkspaceWriter
  | Crypto.Crypto
  | SiteOrigin;

/** One runner for each registered job: a job without one does not type-check. */
export type Runners = {
  readonly [Name in JobRegistry.RegisteredJob]: Runner<TickServices>;
};

/**
 * A job that is one transaction (the semesters, the digest): nothing to read from a provider, one chunk, done. Its
 * counts are what its result says, as integers.
 */
const oneShot = <A, R>(
  work: Effect.Effect<A, DomainError, R | InTransaction | CurrentPrincipal>,
  counts: (result: A) => JobRun.Counts
): Runner<R> => ({
  prepare: () =>
    Effect.succeed(
      Effect.map(work, (result) => ({
        counts: counts(result),
        cursor: null,
        done: true,
      }))
    ),
});

/**
 * The safety net of the queue (spec 0008b): the outbox rows are the record, and the queue only carries their ids. Each chunk
 * asks the command for up to `chunkSize` pending rows that no receipt covers any more (the rows that a crash between
 * commit and enqueue, or a message the queue lost, left behind) and puts their ids on the queue again; the receipt is
 * written by the publisher. It delivers nothing: the consumer does, and a duplicate message is harmless (the claim is
 * conditional). Nothing here runs inside a transaction, which is why the sweep runs in `prepare`. A full chunk means more
 * may be stale, so it goes on until the job's budget; what is left is found by the next tick.
 */
const sweepOutbox = Effect.gen(function* sweep() {
  const { chunkSize: limit, chunksPerTick: budget } = JobRegistry.outboxSweep;
  const publisher = yield* OutboxPublisher;
  let chunks = 0;
  let queued = 0;

  while (chunks < budget) {
    const { stale } = yield* withOutbox((client) =>
      client.sweepOutbox({ limit })
    );

    chunks += 1;
    queued += stale.length;
    yield* publisher.publish(stale);

    if (stale.length < limit) {
      break;
    }
  }

  yield* Effect.logInfo("outbox sweep finished").pipe(
    Effect.annotateLogs({ queued })
  );

  return { queued };
});

/**
 * The Workspace projection (spec 0008): the directory is read in `prepare`, outside any transaction, and the chunk
 * and its cursor commit together. Named, so a test can run it with the services it needs and no others.
 */
export const workspaceSyncRunner = {
  prepare: (held: JobRun.Held) =>
    Effect.map(prepareSync(held.cursor), (directory) =>
      withWorkspace((client) =>
        client.syncWorkspace({
          cursor: held.cursor,
          directory,
          period: held.period,
        })
      )
    ),
};

/**
 * The nightly retention run (spec 0007b): one transaction, in the mode that the job database fixed. It runs on the
 * retention cron like every other job. It logs the counts that its audit row holds, and never a value.
 */
const retentionRunner = oneShot(
  retentionJob.pipe(
    Effect.tap(({ counts, mode }) =>
      Match.value(mode).pipe(
        Match.when("Apply", () => Effect.logInfo("retention run finished")),
        Match.when("ReportOnly", () =>
          Effect.logInfo("retention report finished: nothing was changed")
        ),
        Match.exhaustive,
        Effect.annotateLogs(counts)
      )
    )
  ),
  ({ counts }) => counts
);

export const runners: Runners = {
  /**
   * When a person's last engagement ends: one request and one `IssueCode` message each, in one transaction (spec
   * 0007b). The sweep that follows in the same tick mints the code and sends the mail.
   */
  alumniConsent: oneShot(
    alumniConsentJob.pipe(
      Effect.tap(({ sent }) =>
        Effect.logInfo("alumni consent job finished").pipe(
          Effect.annotateLogs({ sent })
        )
      )
    ),
    ({ sent }) => ({ sent })
  ),
  /** Inside the last weeks of the semester; outside them it does nothing, and the ledger makes each mail once. */
  endingSoon: oneShot(
    endingSoonJob.pipe(
      Effect.tap(({ sent }) =>
        Effect.logInfo("ending-soon digest finished").pipe(
          Effect.annotateLogs({ sent })
        )
      )
    ),
    ({ sent }) => ({ sent })
  ),
  outboxSweep: {
    prepare: () =>
      Effect.map(sweepOutbox, (counts) =>
        Effect.succeed({ counts, cursor: null, done: true })
      ),
  },
  retention: retentionRunner,
  /** The current and the next semester exist as rows (spec 0003, RULE-237). */
  semesters: oneShot(
    semesterJob.pipe(
      Effect.tap(({ current, next }) =>
        Effect.logInfo("semester job finished").pipe(
          Effect.annotateLogs({
            current: semesterLabel(current),
            next: semesterLabel(next),
          })
        )
      )
    ),
    () => ({ semesters: 2 })
  ),
  workspaceSync: workspaceSyncRunner,
};
