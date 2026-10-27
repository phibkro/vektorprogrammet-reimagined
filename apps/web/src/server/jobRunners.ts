/**
 * The runner of every registered job (spec 0008). The table is typed over exactly the names of the registry
 * (`RegisteredJob`), so a job that is declared and has no runner does not type-check, and a runner without a
 * declaration does not either. Each runner is the job's own System command, run by the scheduler as that principal
 * through `authorize`; the registry adds the schedule, the budget and the record of runs, and no second way to write.
 */
import {
  JobRegistry,
  endingSoonJob,
  prepareSync,
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
import { Array as Arr, Effect } from "effect";
import type { Crypto } from "effect";

import type { AccountDelivery } from "./accountDelivery";
import type { Runner } from "./jobs";
import { withOutbox } from "./outboxSweep";
import type { DatabaseServices } from "./runtime";
import type { MessageSender } from "./senders";

/** Everything the runners (and so a tick) need besides the transaction runner, which the scheduler itself holds. */
export type TickServices =
  | DatabaseServices
  | AccountDelivery
  | MessageSender
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
 * The outbox rows are the queue: each chunk claims up to `chunkSize` due rows (`SKIP LOCKED`, fenced by claim
 * tokens), provider calls included, none inside a transaction, which is why the sweep runs in `prepare`. A full chunk
 * means more may be due, so it goes on until the job's budget; what is left is found by the next tick's own claim.
 */
const sweepOutbox = Effect.gen(function* sweep() {
  const { chunkSize: limit, chunksPerTick: budget } = JobRegistry.outboxSweep;
  let chunks = 0;
  let rows = 0;
  let delivered = 0;

  while (chunks < budget) {
    const results = yield* withOutbox((client) =>
      client.sweepOutbox({ limit })
    );

    chunks += 1;
    rows += results.length;
    delivered += Arr.filter(
      results,
      (result) => result.outcome === "delivered"
    ).length;

    if (results.length < limit) {
      break;
    }
  }

  yield* Effect.logInfo("outbox delivery finished").pipe(
    Effect.annotateLogs({ rows })
  );

  return { delivered, rows };
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

export const runners: Runners = {
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
