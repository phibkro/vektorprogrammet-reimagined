/**
 * The wire contract between the spike Worker and the smoke command. The Worker
 * encodes its answers with these schemas and the smoke command decodes them, so
 * neither side can drift. Request parameters travel in the query string.
 */
import { Schema } from "effect";

/** One smoke run; every row a run writes is keyed by it, so reruns never collide. */
const RunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{7,63}$/u))
);

const SemesterTerm = Schema.Literals(["VAR", "HOST"]);

const IntFromString = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt())
);

/** Query parameters of each endpoint, decoded by the Worker. */
export const RunParams = Schema.Struct({ run: RunId });

export const SemesterParams = Schema.Struct({
  term: SemesterTerm,
  year: IntFromString,
});

export const UpsertParams = Schema.Struct({
  ...SemesterParams.fields,
  mode: Schema.Literals(["update", "nothing"]),
});

export const CacheParams = Schema.Struct({
  from: IntFromString,
  run: RunId,
});

export const BcryptParams = Schema.Struct({
  which: Schema.Literals(["right", "wrong"]),
});

/** The placement experiment: how many dependent statements `/chain` runs in one transaction (the sizes of research §C). */
export const ChainParams = Schema.Struct({
  n: IntFromString.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(17)
    )
  ),
});

export const routes = {
  abort: "/checks/abort",
  abortProbe: "/checks/abort-probe",
  bcrypt: "/checks/bcrypt",
  cache: "/checks/cache",
  chain: "/chain",
  codec: "/checks/codec",
  commit: "/checks/commit",
  connect: "/checks/connect",
  ping: "/checks/ping",
  rollbackTyped: "/checks/rollback-typed",
  rows: "/checks/rows",
  sanitize: "/checks/sanitize",
  savepoint: "/checks/savepoint",
  semesters: "/checks/semesters",
  unique: "/checks/unique",
  upsert: "/checks/upsert",
} as const;

/** First line of the `abort` stream: the row is written inside the open transaction. */
export const ABORT_READY_LINE = "inserted";

export const Ping = Schema.Struct({ ok: Schema.Literal(true) });

/**
 * `/chain`: `n` sequential dependent `select` statements in one transaction, timed inside the Worker.
 * `statementsMs` covers the statement loop; `dbMs` covers the transaction call, including BEGIN and COMMIT.
 * `totalMs` covers the chain handler after parameter decoding through its result, before response encoding.
 * The client measures end-to-end time separately. `variant` names the deployed placement arm.
 */
export const Chain = Schema.Struct({
  dbMs: Schema.Finite,
  n: Schema.Int,
  statementsMs: Schema.Finite,
  totalMs: Schema.Finite,
  value: Schema.Int,
  variant: Schema.String,
});

/** Check 1: `select 1` through the SqlClient and through Drizzle, and who answered. */
export const Connect = Schema.Struct({
  database: Schema.String,
  drizzleOne: Schema.Finite,
  hyperdriveHost: Schema.String,
  sqlOne: Schema.Finite,
  user: Schema.String,
  version: Schema.String,
  workerVersion: Schema.String,
});

/** The labels a run has committed, read by a later request. */
export const Rows = Schema.Struct({ labels: Schema.Array(Schema.String) });

/** Checks 3a and 4: the `_tag` of the typed failure that rolled the (inner) transaction back. */
export const RolledBack = Schema.Struct({ failure: Schema.String });

/** Check 2: the transaction returned, so it committed. */
export const Committed = Schema.Struct({ committed: Schema.Literal(true) });

/** Check 3b: whether the aborted transaction left the key free (rolled back) or taken (committed). */
export const AbortProbe = Schema.Struct({ free: Schema.Boolean });

const SemesterRow = Schema.Struct({
  id: Schema.Int,
  term: Schema.String,
  year: Schema.Int,
});

/** Check 5 and 8: the row `RETURNING` produced, or none. */
export const Upserted = Schema.Struct({ row: Schema.NullOr(SemesterRow) });

export const Semesters = Schema.Struct({ rows: Schema.Array(SemesterRow) });

export const ClassifiedAlreadyExists = Schema.TaggedStruct("AlreadyExists", {
  entity: Schema.String,
  key: Schema.String,
});

export const ClassifiedDefect = Schema.TaggedStruct("Defect", {
  message: Schema.String,
});

export const ClassifiedInserted = Schema.TaggedStruct("Inserted", {});

/** Check 6: how `classifySqlFailure` ruled on the second insert of one key. */
export const Unique = Schema.Struct({
  classified: Schema.Union([
    ClassifiedAlreadyExists,
    ClassifiedDefect,
    ClassifiedInserted,
  ]),
});

/** One value set as a driver returned it. */
const CodecValues = Schema.Struct({
  amount: Schema.String,
  at: Schema.String,
  day: Schema.String,
  doc: Schema.Unknown,
});

/** Check 7: sample `slot` was written through `writtenVia` and read back through both clients. */
const CodecRead = Schema.Struct({
  drizzle: CodecValues,
  slot: Schema.Int,
  sql: CodecValues,
  writtenVia: Schema.Literals(["drizzle", "sql"]),
});

export const Codec = Schema.Struct({ reads: Schema.Array(CodecRead) });

/** Check 9: the sanitizer's output for each corpus payload and for the allowed sample, in order. */
export const Sanitize = Schema.Struct({
  allowed: Schema.String,
  outputs: Schema.Array(Schema.String),
});

/** Check 10: whether the stored hash verified `which`, and the hash's own parameters. */
export const Bcrypt = Schema.Struct({
  cost: Schema.Int,
  prefix: Schema.String,
  verified: Schema.Boolean,
});

/** Check 11: each value written, and the value the very next read returned. */
export const Cache = Schema.Struct({
  rounds: Schema.Array(Schema.Struct({ read: Schema.Int, wrote: Schema.Int })),
});

/** Every non-2xx answer: what failed, for the evidence column. */
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    kind: Schema.Literals(["bad-request", "defect", "typed"]),
    message: Schema.String,
  }),
});
