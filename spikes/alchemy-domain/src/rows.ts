/**
 * What the platform's tables hold, as schemas: every row and every stored document is decoded where it enters.
 * `Json` is `unknown` in `@alchemy.run/domain/Platform` (the kernel owns the shape of an event, a state or a command,
 * and a platform only moves them), so those fields stay `unknown` here; everything around them is typed.
 */
import { Array as Arr, Record as Rec, Schema } from "effect";

const TraceSchema = Schema.Struct({
  sampled: Schema.Boolean,
  spanId: Schema.String,
  traceId: Schema.String,
});

export const EnvelopeSchema = Schema.Struct({
  at: Schema.Finite,
  commandId: Schema.String,
  correlationId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  seq: Schema.Int,
  stream: Schema.String,
  trace: Schema.optionalKey(TraceSchema),
});

export const StoredEventSchema = Schema.Struct({
  envelope: EnvelopeSchema,
  event: Schema.Unknown,
});

export const DeliverySchema = Schema.Struct({
  envelope: EnvelopeSchema,
  event: Schema.Unknown,
  history: Schema.optionalKey(Schema.Boolean),
  key: Schema.String,
  origin: Schema.String,
  routes: Schema.optionalKey(Schema.Array(Schema.String)),
  seq: Schema.Int,
  source: Schema.String,
  state: Schema.optionalKey(Schema.Unknown),
  tag: Schema.String,
  target: Schema.Struct({
    kind: Schema.Literals(["view", "policy", "projection"]),
    name: Schema.String,
  }),
});

/** What the platform is handed with a command (`Aggregate.SendMeta`), as a scheduled command stores it. */
export const SendMetaSchema = Schema.Struct({
  commandId: Schema.String,
  context: Schema.Record(Schema.String, Schema.Unknown),
  correlationId: Schema.optionalKey(Schema.String),
  link: Schema.optionalKey(Schema.Boolean),
  trace: Schema.optionalKey(TraceSchema),
});

/** The answer to a command, as a receipt stores it: a rejection or an accepted receipt. */
export const SendResultSchema = Schema.TaggedUnion({
  Accepted: {
    receipt: Schema.Struct({
      events: Schema.Array(Schema.Unknown),
      reply: Schema.Unknown,
      stream: Schema.String,
      version: Schema.Int,
    }),
  },
  Rejected: { rejection: Schema.Unknown },
});

export const InstanceRow = Schema.Struct({
  receipt: Schema.Unknown,
  state: Schema.Unknown,
  version: Schema.Int,
});

export const StateRow = Schema.Struct({
  state: Schema.Unknown,
  version: Schema.Int,
});

export const DeliveryRow = Schema.Struct({
  delivery: DeliverySchema,
  position: Schema.Int,
});

export const CheckpointRow = Schema.Struct({
  seq: Schema.Int,
  source: Schema.String,
});

export const ScheduledRow = Schema.Struct({
  aggregate: Schema.String,
  command: Schema.Unknown,
  commandId: Schema.String,
  id: Schema.String,
  meta: SendMetaSchema,
});

export const PendingInstance = Schema.Struct({
  aggregate: Schema.String,
  id: Schema.String,
});

/** `jsonb` parameters travel as JSON text: `Json` is anything the kernel encoded. */
export const toJsonText = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown)
);

/** The last handled `seq` of each source stream, from the rows of a checkpoint query. */
export const checkpointsOf = (rows: readonly (typeof CheckpointRow.Type)[]) =>
  Rec.fromEntries(Arr.map(rows, (row) => [row.source, row.seq] as const));
