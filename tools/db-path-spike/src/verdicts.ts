/**
 * What each check's pass means (spec 0000), as pure functions of the Worker's answers.
 * The Worker only reports facts; the verdict lives here, so a Worker that misreports
 * cannot grade itself. `smoke.ts` gathers the answers and prints these lines.
 */
import { Array as Arr, Match, Option } from "effect";
import * as Formatter from "effect/Formatter";

import {
  allowedRichText,
  bcryptProbe,
  codecSamples,
  xssCorpus,
} from "./fixtures.ts";
import type * as Protocol from "./protocol.ts";

/** The role Hyperdrive connects as (spec 0000, check 1). */
const EXPECTED_ROLE = "vp_app";

export interface Verdict {
  readonly evidence: string;
  readonly pass: boolean;
}

const verdict = (pass: boolean, evidence: string): Verdict => ({
  evidence,
  pass,
});

/** A check that got no usable answer: it fails, and the error is the evidence. */
export const failure = (evidence: string) => verdict(false, evidence);

/** The suffix of every Hyperdrive binding host: a Worker on Hyperdrive never sees the origin address. */
const HYPERDRIVE_HOST_SUFFIX = ".hyperdrive.local";

/** An evidence value as compact JSON text. */
const show = Formatter.formatJson;

export const connectVerdict = (connect: typeof Protocol.Connect.Type) =>
  verdict(
    connect.sqlOne === 1 &&
      connect.drizzleOne === 1 &&
      connect.hyperdriveHost.endsWith(HYPERDRIVE_HOST_SUFFIX) &&
      connect.user === EXPECTED_ROLE,
    `select 1 = ${connect.sqlOne} through the SqlClient and ${connect.drizzleOne} through Drizzle; ` +
      `the Worker's only database address is Hyperdrive (${connect.hyperdriveHost}); ` +
      `${connect.user}@${connect.database}, ${connect.version.split(" on ")[0] ?? connect.version}; ` +
      `Worker version ${connect.workerVersion}`
  );

export const commitVerdict = (
  committed: typeof Protocol.Committed.Type,
  labels: readonly string[]
) =>
  verdict(
    committed.committed && labels.includes("commit"),
    `the transaction returned; a later request reads ${show(labels)}`
  );

export const typedRollbackVerdict = (
  rolledBack: typeof Protocol.RolledBack.Type,
  labels: readonly string[]
) =>
  verdict(
    rolledBack.failure === "SpikeRollback" && labels.length === 0,
    `failed with ${rolledBack.failure}; a later request reads ${show(labels)}`
  );

export const abortVerdict = (
  probe: typeof Protocol.AbortProbe.Type,
  labels: readonly string[],
  waitedMillis: number
) =>
  verdict(
    probe.free && !labels.includes("abort"),
    probe.free
      ? `the aborted transaction's key was free after ${waitedMillis} ms and a later request reads ${show(labels)}`
      : `the aborted transaction COMMITTED: its key was taken after ${waitedMillis} ms (rows ${show(labels)})`
  );

export const savepointVerdict = (
  nested: typeof Protocol.RolledBack.Type,
  labels: readonly string[]
) =>
  verdict(
    nested.failure === "SpikeRollback" &&
      labels.length === 1 &&
      labels[0] === "outer",
    `inner failed with ${nested.failure}; a later request reads ${show(labels)}`
  );

type UpsertPair = readonly [
  typeof Protocol.Upserted.Type,
  typeof Protocol.Upserted.Type,
];

export interface UpsertAnswers {
  readonly nothing: UpsertPair;
  readonly update: UpsertPair;
}

const rowText = (row: typeof Protocol.Upserted.Type.row) =>
  row === null ? "no row" : `id ${row.id}`;

export const upsertVerdict = ({ nothing, update }: UpsertAnswers) => {
  const [created, repeated] = nothing;
  const [updated, updatedAgain] = update;

  return verdict(
    created.row !== null &&
      repeated.row === null &&
      updated.row !== null &&
      updatedAgain.row?.id === updated.row.id,
    `DO NOTHING returned ${rowText(created.row)}, then ${rowText(repeated.row)}; ` +
      `DO UPDATE returned ${rowText(updated.row)}, then ${rowText(updatedAgain.row)}`
  );
};

export const uniqueVerdict = (unique: typeof Protocol.Unique.Type) =>
  Match.value(unique.classified).pipe(
    Match.tag("AlreadyExists", ({ entity, key }) =>
      verdict(
        true,
        `the duplicate insert failed as AlreadyExists(${entity}, "${key}")`
      )
    ),
    Match.tag("Defect", ({ message }) =>
      verdict(false, `classifySqlFailure made it a defect: ${message}`)
    ),
    Match.tag("Inserted", () =>
      verdict(false, "the duplicate insert succeeded")
    ),
    Match.exhaustive
  );

const codecFields = ["amount", "at", "day", "doc"] as const;

/** The first value a driver changed on its way through, as text. */
const firstCodecMismatch = (reads: typeof Protocol.Codec.Type.reads) =>
  Arr.head(
    Arr.flatMap(reads, (read) => {
      const sample = codecSamples[Math.floor(read.slot / 2)];

      return Arr.flatMap(["drizzle", "sql"] as const, (client) =>
        Arr.flatMap(codecFields, (field) =>
          show(read[client][field]) === show(sample?.[field])
            ? []
            : [
                `${field} written through ${read.writtenVia}, read through ${client}: ${show(sample?.[field])} became ${show(read[client][field])}`,
              ]
        )
      );
    })
  );

export const codecVerdict = (codec: typeof Protocol.Codec.Type) => {
  const mismatch = firstCodecMismatch(codec.reads);
  const complete = codec.reads.length === codecSamples.length * 2;

  return verdict(
    Option.isNone(mismatch) && complete,
    Option.getOrElse(mismatch, () =>
      complete
        ? `${codecSamples.length} samples (two DST-edge instants among them) written through Drizzle and through the SqlClient and read back through both: all ${codec.reads.length * 2} reads equal`
        : `expected ${codecSamples.length * 2} reads, got ${codec.reads.length}`
    )
  );
};

export interface RaceAnswers {
  readonly callers: number;
  readonly failures: readonly string[];
  readonly ids: readonly number[];
  readonly rows: number;
}

export const raceVerdict = ({ callers, failures, ids, rows }: RaceAnswers) => {
  const distinct = Arr.dedupe(ids);

  return verdict(
    failures.length === 0 && rows === 1 && distinct.length === 1,
    failures.length > 0
      ? `${failures.length} of ${callers} requests failed: ${failures[0]}`
      : `${callers} concurrent upserts all returned the row ${Arr.join(Arr.map(distinct, String), ", ")}; ${rows} row${rows === 1 ? "" : "s"} for the key`
  );
};

const markup = [
  /<\s*(?:script|iframe|object|embed|svg|math|style|form|input|base|meta|link|body)\b/iu,
  /\bon[a-z]+\s*=/iu,
  /(?:javascript|vbscript|data)\s*:/iu,
];

/** Output that still carries something active, whatever the expected text says. */
const active = (output: string) =>
  Arr.some(markup, (pattern) => pattern.test(output));

export const sanitizeVerdict = (sanitize: typeof Protocol.Sanitize.Type) => {
  const differing = Arr.findFirst(
    Arr.map(xssCorpus, ([input, expected], index) => ({
      expected,
      got: sanitize.outputs[index] ?? "(missing)",
      input,
    })),
    ({ expected, got }) => got !== expected || active(got)
  );

  const allowedKept = sanitize.allowed === allowedRichText;

  const evidence = Option.match(differing, {
    onNone: () =>
      allowedKept
        ? `${xssCorpus.length} XSS payloads neutralised exactly as in Node; every allowed tag and attribute survived`
        : "the allowed tags did not survive unchanged",
    onSome: (payload) =>
      `${show(payload.input)} became ${show(payload.got)}, expected ${show(payload.expected)}`,
  });

  return verdict(
    Option.isNone(differing) &&
      allowedKept &&
      sanitize.outputs.length === xssCorpus.length,
    evidence
  );
};

export interface BcryptAnswers {
  readonly baselineMillis: number;
  readonly right: typeof Protocol.Bcrypt.Type;
  readonly rightMillis: number;
  readonly wrong: typeof Protocol.Bcrypt.Type;
}

export const bcryptVerdict = ({
  baselineMillis,
  right,
  rightMillis,
  wrong,
}: BcryptAnswers) =>
  verdict(
    right.verified &&
      !wrong.verified &&
      right.prefix === bcryptProbe.prefix &&
      right.cost === bcryptProbe.cost,
    `${right.prefix} hash ${right.verified ? "verified" : "did NOT verify"} and a wrong input ${wrong.verified ? "VERIFIED" : "was refused"}; ` +
      `request ${rightMillis} ms against a ${baselineMillis} ms no-op request, so at most ${Math.max(0, rightMillis - baselineMillis)} ms of CPU (client-observed wall clock, an upper bound)`
  );

export const cacheVerdict = (
  rounds: readonly (typeof Protocol.Cache.Type.rounds)[number][]
) => {
  const stale = Arr.findFirst(rounds, (round) => round.read !== round.wrote);

  return verdict(
    Option.isNone(stale) && rounds.length > 0,
    Option.match(stale, {
      onNone: () =>
        `${rounds.length} writes, each read back at once with the same query text in the same and in a later request: every read returned the value just written`,
      onSome: (round) =>
        `a read after writing ${round.wrote} returned ${round.read}`,
    })
  );
};

const CPU_LIMIT = /1102|exceeded.*(?:cpu|resource)/iu;

/** Why a request produced no answer; the evidence of a failed check. */
export const describeRefusal = (status: number, message: string) =>
  CPU_LIMIT.test(message)
    ? `HTTP ${status}: the Worker hit the Workers CPU limit (${message.slice(0, 120)})`
    : `HTTP ${status}: ${message.slice(0, 400)}`;
