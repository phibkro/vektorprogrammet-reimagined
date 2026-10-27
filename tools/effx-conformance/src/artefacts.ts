/**
 * The committed artefacts of spec 0007d, and how to read and write them: per domain the description that the kernel
 * exports (`<domain>.description.json`) and the vectors that effx made from it (`<domain>.vectors.json.gz`); and the
 * pin of the effx commit, the register of gaps and the provenance that ties each vectors file to its description.
 * Paths are relative to this tool's directory, as `tools/docgen`'s are.
 */
import {
  Array as Arr,
  Crypto,
  Effect,
  FileSystem,
  Schema,
  Stream,
} from "effect";

export const directory = "../../packages/domain/conformance";

export const descriptionFile = (domain: string) =>
  `${directory}/${domain}.description.json`;

export const vectorsFile = (domain: string) =>
  `${directory}/${domain}.vectors.json.gz`;

export const provenanceFile = `${directory}/provenance.json`;

export const gapsFile = `${directory}/gaps.json`;

export const pinFile = `${directory}/effx.pin.json`;

/** The one effx commit that the vectors are made with; moving it is a deliberate change, with the files regenerated. */
export const Pin = Schema.Struct({
  alloy: Schema.String,
  commit: Schema.String,
  repository: Schema.String,
});

export type PinFile = typeof Pin.Type;

const Assertion = Schema.Struct({
  name: Schema.String,
  result: Schema.Literals(["PASS", "NOT APPLICABLE"]),
});

const DomainProvenance = Schema.Struct({
  assertions: Schema.Array(Assertion),
  descriptionSha256: Schema.String,
  instances: Schema.Int,
  nondeterministic: Schema.Array(Schema.String),
  orderedAtoms: Schema.Int,
  rows: Schema.Struct({
    authorization: Schema.Int,
    transitions: Schema.Int,
  }),
  scope: Schema.Int,
  steps: Schema.Int,
  unknownGuards: Schema.Array(Schema.String),
  vectorsSha256: Schema.String,
});

/** Where each vectors file comes from: no date, so the same inputs give the same bytes. */
export const Provenance = Schema.Struct({
  alloy: Schema.Struct({ executable: Schema.String, version: Schema.String }),
  domains: Schema.Record(Schema.String, DomainProvenance),
  effx: Schema.Struct({
    commit: Schema.String,
    nixpkgs: Schema.String,
    repository: Schema.String,
  }),
});

export type ProvenanceFile = typeof Provenance.Type;

// oxlint-disable unicorn/throw-new-error -- EX-0030: this is a Schema.TaggedError declaration, not a throw.
export class ArtefactFailed extends Schema.TaggedError<
  ArtefactFailed,
  { readonly brand: unique symbol }
>()("ArtefactFailed", {
  message: Schema.String,
}) {}
// oxlint-enable unicorn/throw-new-error

/** The lowercase hexadecimal SHA-256 of some bytes. */
export const sha256Hex = Effect.fn("sha256Hex")(function* sha256Hex(
  bytes: Uint8Array
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", bytes);

  return Arr.join(
    Arr.map(Arr.fromIterable(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ),
    ""
  );
});

/** Some bytes through a web stream transform, read to the end. */
const through = (
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream
) =>
  Stream.fromReadableStream({
    evaluate: () =>
      new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform),
    onError: (cause) => new ArtefactFailed({ message: String(cause) }),
  }).pipe(Stream.mkUint8Array);

export const gzip = (bytes: Uint8Array) =>
  through(bytes, new CompressionStream("gzip"));

export const gunzip = (bytes: Uint8Array) =>
  through(bytes, new DecompressionStream("gzip"));

/** The UTF-8 bytes of a text. */
export const utf8 = (text: string) => new TextEncoder().encode(text);

/** A committed JSON file, decoded with its schema. */
export const readJson = Effect.fn("readJson")(function* readJson<
  S extends Schema.Decoder<unknown>,
>(schema: S, file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file);

  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
});
