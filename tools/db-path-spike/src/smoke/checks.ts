/**
 * The checks of spec 0000, in the order of its table. Each one sends requests to the
 * deployed Worker and judges the answers with `verdicts.ts`; a request that gets no
 * usable answer is a failing line with the error as its evidence, never a retry.
 */
import {
  Array as Arr,
  Cause,
  Duration,
  Effect,
  Exit,
  Option,
  String as Str,
} from "effect";

import { bcryptProbe } from "../fixtures.ts";
import * as Protocol from "../protocol.ts";
import {
  abortVerdict,
  bcryptVerdict,
  cacheVerdict,
  codecVerdict,
  commitVerdict,
  connectVerdict,
  failure,
  raceVerdict,
  sanitizeVerdict,
  savepointVerdict,
  typedRollbackVerdict,
  uniqueVerdict,
  upsertVerdict,
} from "../verdicts.ts";
import type { Verdict } from "../verdicts.ts";
import { SpikeClient } from "./client.ts";
import type { RequestRefused } from "./refused.ts";

/** One smoke run: its key prefix for every row, and a base year no other run shares. */
export interface Run {
  readonly id: string;
  readonly year: number;
}

export interface Check {
  readonly id: string;
  readonly run: Effect.Effect<Verdict, RequestRefused, SpikeClient>;
  readonly title: string;
}

/** Concurrent callers in check 8 (spec 0000). */
const CALLERS = 20;

/** The labels a later request reads for the run. */
const labelsOf = (run: Run) =>
  SpikeClient.use((spike) =>
    Effect.map(
      spike.get(Protocol.routes.rows, { run: run.id }, Protocol.Rows),
      (rows) => rows.labels
    )
  );

const connect = SpikeClient.use((spike) =>
  Effect.map(
    spike.get(Protocol.routes.connect, {}, Protocol.Connect),
    connectVerdict
  )
);

const commit = (run: Run) =>
  Effect.gen(function* commitCheck() {
    const spike = yield* SpikeClient;

    const committed = yield* spike.post(
      Protocol.routes.commit,
      { run: run.id },
      Protocol.Committed
    );

    return commitVerdict(committed, yield* labelsOf(run));
  });

const typedRollback = (run: Run) =>
  Effect.gen(function* typedRollbackCheck() {
    const spike = yield* SpikeClient;

    const rolledBack = yield* spike.post(
      Protocol.routes.rollbackTyped,
      { run: run.id },
      Protocol.RolledBack
    );

    return typedRollbackVerdict(rolledBack, yield* labelsOf(run));
  });

/**
 * The write happens inside an open transaction, the Worker says so, and the request is
 * dropped. The probe then asks for the aborted key, which waits for the transaction to end.
 */
const abort = (run: Run) =>
  Effect.gen(function* abortCheck() {
    const spike = yield* SpikeClient;

    const first = yield* spike.postUntilFirstText(Protocol.routes.abort, {
      run: run.id,
    });

    if (!Str.includes(Protocol.ABORT_READY_LINE)(first)) {
      return failure(
        `the Worker never reported the write inside the open transaction: ${Str.slice(0, 300)(first)}`
      );
    }

    const [waited, probe] = yield* Effect.timed(
      spike.post(
        Protocol.routes.abortProbe,
        { run: run.id },
        Protocol.AbortProbe
      )
    );

    return abortVerdict(
      probe,
      yield* labelsOf(run),
      Math.round(Duration.toMillis(waited))
    );
  });

const savepoint = (run: Run) =>
  Effect.gen(function* savepointCheck() {
    const spike = yield* SpikeClient;

    const nested = yield* spike.post(
      Protocol.routes.savepoint,
      { run: run.id },
      Protocol.RolledBack
    );

    return savepointVerdict(nested, yield* labelsOf(run));
  });

const upsert = (run: Run) =>
  Effect.gen(function* upsertCheck() {
    const spike = yield* SpikeClient;

    const once = (year: number, mode: "nothing" | "update") =>
      spike.post(
        Protocol.routes.upsert,
        { mode, term: "HOST", year: String(year) },
        Protocol.Upserted
      );

    return upsertVerdict({
      nothing: yield* Effect.all([
        once(run.year, "nothing"),
        once(run.year, "nothing"),
      ]),
      update: yield* Effect.all([
        once(run.year + 1, "update"),
        once(run.year + 1, "update"),
      ]),
    });
  });

const unique = (run: Run) =>
  SpikeClient.use((spike) =>
    Effect.map(
      spike.post(
        Protocol.routes.unique,
        { term: "VAR", year: String(run.year + 2) },
        Protocol.Unique
      ),
      uniqueVerdict
    )
  );

const codec = (run: Run) =>
  SpikeClient.use((spike) =>
    Effect.map(
      spike.post(Protocol.routes.codec, { run: run.id }, Protocol.Codec),
      codecVerdict
    )
  );

/** 20 requests at once, each its own Worker invocation with its own pool, all upserting one key. */
const race = (run: Run) =>
  Effect.gen(function* raceCheck() {
    const spike = yield* SpikeClient;
    const year = run.year + 3;

    const exits = yield* Effect.forEach(
      Arr.range(1, CALLERS),
      () =>
        Effect.exit(
          spike.post(
            Protocol.routes.upsert,
            { mode: "update", term: "HOST", year: String(year) },
            Protocol.Upserted
          )
        ),
      { concurrency: "unbounded" }
    );

    const rows = yield* spike.get(
      Protocol.routes.semesters,
      { term: "HOST", year: String(year) },
      Protocol.Semesters
    );

    return raceVerdict({
      callers: CALLERS,
      failures: Arr.flatMap(exits, (exit) => {
        if (Exit.isFailure(exit)) {
          return [Str.slice(0, 300)(Cause.pretty(exit.cause))];
        }

        return exit.value.row === null ? ["no row returned"] : [];
      }),
      ids: Arr.flatMap(exits, (exit) =>
        Exit.isSuccess(exit) && exit.value.row !== null
          ? [exit.value.row.id]
          : []
      ),
      rows: rows.rows.length,
    });
  });

const sanitize = SpikeClient.use((spike) =>
  Effect.map(
    spike.get(Protocol.routes.sanitize, {}, Protocol.Sanitize),
    sanitizeVerdict
  )
);

/**
 * Three no-op requests set the baseline, then the right and the wrong input. The
 * Worker cannot read its own CPU clock (workerd freezes it during computation), so the
 * smoke command reports the client-observed wall clock above the baseline: an upper bound.
 */
const bcrypt = Effect.gen(function* bcryptCheck() {
  const spike = yield* SpikeClient;

  const pings = yield* Effect.forEach(Arr.range(1, 3), () =>
    Effect.timed(spike.get(Protocol.routes.ping, {}, Protocol.Ping))
  );

  const [rightTime, right] = yield* Effect.timed(
    spike.post(Protocol.routes.bcrypt, { which: "right" }, Protocol.Bcrypt)
  );

  const wrong = yield* spike.post(
    Protocol.routes.bcrypt,
    { which: "wrong" },
    Protocol.Bcrypt
  );

  return bcryptVerdict({
    baselineMillis: Math.round(
      Math.min(...Arr.map(pings, ([time]) => Duration.toMillis(time)))
    ),
    right,
    rightMillis: Math.round(Duration.toMillis(rightTime)),
    wrong,
  });
});

/** Two requests of five write-then-read rounds each: the same query text is read again in a later request. */
const cache = (run: Run) =>
  Effect.gen(function* cacheCheck() {
    const spike = yield* SpikeClient;

    const first = yield* spike.post(
      Protocol.routes.cache,
      { from: "1", run: run.id },
      Protocol.Cache
    );

    const second = yield* spike.post(
      Protocol.routes.cache,
      { from: "6", run: run.id },
      Protocol.Cache
    );

    return cacheVerdict([...first.rounds, ...second.rounds]);
  });

/** The run's key for one check, so a check never reads the rows of another. */
const keyed = (run: Run, check: string): Run => ({
  id: `${run.id}-${check}`,
  year: run.year,
});

export const checks = (run: Run): readonly Check[] => [
  {
    id: "1",
    run: connect,
    title: "connect and select 1 through PgClient and Drizzle effect-postgres",
  },
  {
    id: "2",
    run: commit(keyed(run, "2")),
    title: "a transaction that commits",
  },
  {
    id: "3a",
    run: typedRollback(keyed(run, "3a")),
    title: "rollback on a typed failure",
  },
  {
    id: "3b",
    run: abort(keyed(run, "3b")),
    title: "rollback on interruption (the request is aborted mid-transaction)",
  },
  {
    id: "4",
    run: savepoint(keyed(run, "4")),
    title: "nested savepoint: inner failure, outer commit",
  },
  { id: "5", run: upsert(run), title: "INSERT ... ON CONFLICT ... RETURNING" },
  {
    id: "6",
    run: unique(run),
    title: "unique violation classified by classifySqlFailure",
  },
  {
    id: "7",
    run: codec(keyed(run, "7")),
    title: "timestamptz, date, jsonb and numeric round trips",
  },
  {
    id: "8",
    run: race(run),
    title: `${CALLERS} concurrent ON CONFLICT upserts on one key`,
  },
  {
    id: "9",
    run: sanitize,
    title: "sanitize-html with the RULE-133 allowlist against an XSS corpus",
  },
  {
    id: "10",
    run: bcrypt,
    title: `bcrypt ${bcryptProbe.prefix} verification and its CPU time`,
  },
  {
    id: "11",
    run: cache(keyed(run, "11")),
    title: "Hyperdrive cache is off: a write is read back at once",
  },
];

/** Runs one check; whatever goes wrong becomes the failing line's evidence. */
export const runCheck = (check: Check) =>
  check.run.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.succeed(
          failure(
            Option.match(Cause.findErrorOption(cause), {
              onNone: () => Str.slice(0, 400)(Cause.pretty(cause)),
              onSome: (refused) => refused.message,
            })
          )
        )
    ),
    Effect.map((verdict) => ({ id: check.id, title: check.title, verdict }))
  );
