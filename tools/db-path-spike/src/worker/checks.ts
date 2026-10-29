/**
 * One Effect program per check (spec 0000). Each runs inside the per-request stack
 * (`SqlClient` + `SpikeDb`, see `database.ts`) and answers with the evidence the
 * smoke command judges; the verdict itself lives there, never here.
 */
import { classifySqlFailure, transactional } from "@vektorprogrammet/db";
import { sanitizeRichText } from "@vektorprogrammet/domain";
import { compareSync, getRounds } from "bcryptjs";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import {
  Array as Arr,
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  allowedRichText,
  bcryptProbe,
  codecSamples,
  xssCorpus,
} from "../fixtures.ts";
import type { CodecSample } from "../fixtures.ts";
import {
  ClassifiedAlreadyExists,
  ClassifiedDefect,
  ClassifiedInserted,
} from "../protocol.ts";
import type {
  AbortProbe,
  Bcrypt,
  Cache,
  Codec,
  Committed,
  Connect,
  RolledBack,
  Rows,
  Sanitize,
  Semesters,
  Unique,
  Upserted,
} from "../protocol.ts";
import {
  spikeCodec,
  spikeCounter,
  spikeRow,
  spikeSemester,
} from "../schema.ts";
import { SpikeDb } from "./database.ts";

/** The typed failure checks 3a, 4 and the probe use to force a rollback. */
class SpikeRollback extends Schema.TaggedError<
  SpikeRollback,
  { readonly brand: unique symbol }
>()("SpikeRollback", {
  run: Schema.String,
}) {}

/** How long the `abort` transaction stays open if nothing interrupts it; long enough for a client to abort, short enough to bound a failing run. */
const ABORT_HOLD = Duration.seconds(20);

/** The first row of a raw result, decoded at the boundary; an empty result is a failure. */
const decodeFirst =
  <A>(schema: Schema.Decoder<A>) =>
  (rows: readonly unknown[]) =>
    Schema.decodeEffect(Schema.Array(schema))(rows).pipe(
      Effect.flatMap((decoded) => Effect.fromNullishOr(decoded[0]))
    );

const insertRow = Effect.fnUntraced(function* insertRow(
  run: string,
  label: string
) {
  const db = yield* SpikeDb;

  return yield* db.insert(spikeRow).values({ label, run });
});

const semesterColumns = {
  id: spikeSemester.id,
  term: spikeSemester.term,
  year: spikeSemester.year,
};

const Identity = Schema.Struct({
  database: Schema.String,
  one: Schema.Finite,
  user: Schema.String,
  version: Schema.String,
});

const One = Schema.Struct({ one: Schema.Finite });

/** Check 1: `select 1` through the SqlClient (the PgClient) and through Drizzle, and who answered. */
export const connect = Effect.fn("Check.connect")(function* connect(where: {
  readonly hyperdriveHost: string;
  readonly workerVersion: string;
}) {
  const sql = yield* SqlClient;
  const db = yield* SpikeDb;

  const identity =
    yield* sql`select 1 as one, current_database() as database, current_user as "user", version() as version`.pipe(
      Effect.flatMap(decodeFirst(Identity))
    );

  const viaDrizzle = yield* db
    .execute(drizzleSql`select 1 as one`, "objects")
    .pipe(Effect.flatMap(decodeFirst(One)));

  return {
    database: identity.database,
    drizzleOne: viaDrizzle.one,
    hyperdriveHost: where.hyperdriveHost,
    sqlOne: identity.one,
    user: identity.user,
    version: identity.version,
    workerVersion: where.workerVersion,
  } satisfies typeof Connect.Type;
});

/** The labels a run has committed. */
export const rows = Effect.fn("Check.rows")(function* rows(run: string) {
  const db = yield* SpikeDb;

  const found = yield* db
    .select({ label: spikeRow.label })
    .from(spikeRow)
    .where(eq(spikeRow.run, run))
    .orderBy(spikeRow.label);

  return {
    labels: Arr.map(found, (row) => row.label),
  } satisfies typeof Rows.Type;
});

/** Check 2: a transaction that commits. */
export const commit = Effect.fn("Check.commit")(function* commit(run: string) {
  yield* transactional(insertRow(run, "commit"));

  return { committed: true } satisfies typeof Committed.Type;
});

/** Check 3a: a typed failure after the write rolls the write back. */
export const rollbackTyped = Effect.fn("Check.rollbackTyped")(
  function* rollbackTyped(run: string) {
    const failure = yield* transactional(
      Effect.andThen(insertRow(run, "typed"), new SpikeRollback({ run }))
    ).pipe(Effect.flip);

    return { failure: failure._tag } satisfies typeof RolledBack.Type;
  }
);

/**
 * Check 3b: the write happens, the caller learns of it (`announce`), then the
 * transaction waits. An aborted request interrupts the wait and the
 * transaction rolls back; left alone it commits after `ABORT_HOLD`.
 */
export const abortTransaction = Effect.fn("Check.abortTransaction")(
  function* abortTransaction(
    run: string,
    announce: Effect.Effect<void>,
    hold: Duration.Duration = ABORT_HOLD
  ) {
    yield* transactional(
      Effect.gen(function* held() {
        yield* insertRow(run, "abort");
        yield* announce;
        yield* Effect.sleep(hold);
      })
    );

    return { committed: true } satisfies typeof Committed.Type;
  }
);

/**
 * Check 3b, afterwards: insert the aborted run's key. `ON CONFLICT DO NOTHING` waits
 * for an unfinished transaction that holds the key, so an answer means that
 * transaction is over: a returned row means it rolled back, none means it committed.
 */
export const abortProbe = Effect.fn("Check.abortProbe")(function* abortProbe(
  run: string
) {
  const db = yield* SpikeDb;

  const free = yield* transactional(
    Effect.gen(function* probe() {
      const inserted = yield* db
        .insert(spikeRow)
        .values({ label: "abort", run })
        .onConflictDoNothing()
        .returning({ label: spikeRow.label });

      // Remove only the probe's own row; a committed row belongs to the run under test.
      if (inserted.length > 0) {
        yield* db
          .delete(spikeRow)
          .where(and(eq(spikeRow.run, run), eq(spikeRow.label, "abort")));
      }

      return inserted.length > 0;
    })
  );

  return { free } satisfies typeof AbortProbe.Type;
});

/** Check 4: the inner transaction (a savepoint) fails and rolls back; the outer one commits. */
export const savepoint = Effect.fn("Check.savepoint")(function* savepoint(
  run: string
) {
  const innerFailure = yield* transactional(
    Effect.gen(function* outer() {
      yield* insertRow(run, "outer");

      return yield* transactional(
        Effect.andThen(insertRow(run, "inner"), new SpikeRollback({ run }))
      ).pipe(Effect.flip);
    })
  );

  return { failure: innerFailure._tag } satisfies typeof RolledBack.Type;
});

interface Upsert {
  readonly mode: "nothing" | "update";
  readonly term: string;
  readonly year: number;
}

/**
 * Check 5 and 8: the statements Phase 1 uses for RULE-144 (`DO NOTHING`) and
 * RULE-237 (`DO UPDATE`), on the spike's copy of the semester table.
 */
export const upsert = Effect.fn("Check.upsert")(function* upsert({
  mode,
  term,
  year,
}: Upsert) {
  const db = yield* SpikeDb;
  const target = [spikeSemester.term, spikeSemester.year];
  const insert = db.insert(spikeSemester).values({ term, year });

  const returned =
    mode === "nothing"
      ? yield* insert.onConflictDoNothing({ target }).returning(semesterColumns)
      : yield* insert
          .onConflictDoUpdate({
            set: { term: drizzleSql`excluded.term` },
            target,
          })
          .returning(semesterColumns);

  return { row: returned[0] ?? null } satisfies typeof Upserted.Type;
});

/** The rows one (term, year) has, read by a later request. */
export const semesters = Effect.fn("Check.semesters")(function* semesters(
  term: string,
  year: number
) {
  const db = yield* SpikeDb;

  const found = yield* db
    .select(semesterColumns)
    .from(spikeSemester)
    .where(and(eq(spikeSemester.term, term), eq(spikeSemester.year, year)));

  return { rows: found } satisfies typeof Semesters.Type;
});

/** Check 6: insert one key twice; `classifySqlFailure` rules on the second insert's failure. */
export const unique = Effect.fn("Check.unique")(function* unique(
  term: string,
  year: number
) {
  const db = yield* SpikeDb;
  const insert = () => db.insert(spikeSemester).values({ term, year });
  const key = `${term} ${year}`;

  yield* insert();

  const second = yield* Effect.exit(
    insert().pipe(
      Effect.catch((error) => classifySqlFailure(error, key)),
      Effect.asVoid
    )
  );

  const classified: typeof Unique.Type.classified = Exit.match(second, {
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () =>
          ClassifiedDefect.make({
            message: Str.slice(0, 400)(Cause.pretty(cause)),
          }),
        onSome: (error) =>
          ClassifiedAlreadyExists.make({
            entity: error.entity,
            key: error.key,
          }),
      }),
    onSuccess: () => ClassifiedInserted.make({}),
  });

  return { classified } satisfies typeof Unique.Type;
});

const CodecRow = Schema.Struct({
  amount: Schema.String,
  at: Schema.Date,
  day: Schema.String,
  doc: Schema.Unknown,
});

const JsonText = Schema.fromJsonString(Schema.Unknown);

/** One row as a driver returned it, in the shape the contract compares. */
const values = (row: {
  readonly amount: string;
  readonly at: Date;
  readonly day: string;
  readonly doc: unknown;
}) => ({
  amount: row.amount,
  at: row.at.toISOString(),
  day: row.day,
  doc: row.doc,
});

/** Check 7, one sample: written through Drizzle and through the SqlClient, each read back through both. */
const roundTrip = Effect.fn("Check.codec.roundTrip")(function* roundTrip(
  run: string,
  index: number,
  sample: CodecSample
) {
  const db = yield* SpikeDb;
  const sql = yield* SqlClient;
  const at = DateTime.toDate(DateTime.makeUnsafe(sample.at));
  const docText = yield* Schema.encodeEffect(JsonText)(sample.doc);
  const drizzleSlot = index * 2;
  const sqlSlot = index * 2 + 1;

  const readSql = (slot: number) =>
    sql`select at, day::text as day, doc, amount::text as amount
        from spike_0000.spike_codec
        where run = ${run} and slot = ${slot}`.pipe(
      Effect.flatMap(decodeFirst(CodecRow))
    );

  const readDrizzle = (slot: number) =>
    db
      .select()
      .from(spikeCodec)
      .where(and(eq(spikeCodec.run, run), eq(spikeCodec.slot, slot)))
      .pipe(Effect.flatMap((found) => Effect.fromNullishOr(found[0])));

  yield* db.insert(spikeCodec).values({
    amount: sample.amount,
    at,
    day: sample.day,
    doc: sample.doc,
    run,
    slot: drizzleSlot,
  });

  yield* sql`insert into spike_0000.spike_codec (run, slot, at, day, doc, amount)
      values (${run}, ${sqlSlot}, ${at}, ${sample.day}::date, ${docText}::jsonb, ${sample.amount}::numeric)`;

  return yield* Effect.forEach(
    [
      { slot: drizzleSlot, writtenVia: "drizzle" as const },
      { slot: sqlSlot, writtenVia: "sql" as const },
    ],
    ({ slot, writtenVia }) =>
      Effect.all({
        drizzle: Effect.map(readDrizzle(slot), values),
        sql: Effect.map(readSql(slot), values),
      }).pipe(Effect.map((read) => ({ ...read, slot, writtenVia })))
  );
});

/** Check 7: every sample through Drizzle and through the raw SqlClient, both directions. */
export const codec = Effect.fn("Check.codec")(function* codec(run: string) {
  const reads = yield* Effect.forEach(
    Arr.map(codecSamples, (sample, index) => ({ index, sample })),
    ({ index, sample }) => roundTrip(run, index, sample)
  );

  return { reads: reads.flat() } satisfies typeof Codec.Type;
});

/** Check 9: the RULE-133 sanitizer in this runtime. Pure, so no effect. */
export const sanitize = (): typeof Sanitize.Type => ({
  allowed: sanitizeRichText(allowedRichText),
  outputs: Arr.map(xssCorpus, ([input]) => sanitizeRichText(input)),
});

/** Check 10: verify the stored `$2y$12$` hash. Blocks the isolate for the hash's cost, as Phase 2 will. */
export const verifyBcrypt = (which: "right" | "wrong") =>
  Effect.sync((): typeof Bcrypt.Type => ({
    cost: getRounds(bcryptProbe.stored),
    prefix: Str.slice(0, bcryptProbe.prefix.length)(bcryptProbe.stored),
    verified: compareSync(bcryptProbe[which], bcryptProbe.stored),
  }));

/** Rounds of write-then-read in one request (check 11). */
const CACHE_ROUNDS = 5;

/** Check 11: write a value, then read it back at once with the same query text; repeated. */
export const cache = Effect.fn("Check.cache")(function* cache(
  run: string,
  from: number
) {
  const db = yield* SpikeDb;

  yield* db
    .insert(spikeCounter)
    .values({ run, value: from - 1 })
    .onConflictDoNothing();

  const rounds = yield* Effect.forEach(
    Arr.range(from, from + CACHE_ROUNDS - 1),
    (wrote) =>
      Effect.gen(function* round() {
        yield* db
          .update(spikeCounter)
          .set({ value: wrote })
          .where(eq(spikeCounter.run, run));

        const [row] = yield* db
          .select({ value: spikeCounter.value })
          .from(spikeCounter)
          .where(eq(spikeCounter.run, run));

        return { read: row?.value ?? -1, wrote };
      })
  );

  return { rounds } satisfies typeof Cache.Type;
});
