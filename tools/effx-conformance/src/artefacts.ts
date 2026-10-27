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
  Option,
  Record as Rec,
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

/**
 * How effx is asked for the vectors of one domain, as data: the files of the scratch project that effx analyses
 * (`description.json`, the domain's committed description, is one more), what is linked into it, and the commands that
 * run in it. `<effx>` is the checkout of effx at the pinned commit. `regenerate` builds the project from this and the
 * provenance records it, so how the vectors were made can be read and replayed from the committed files, and changing it
 * fails a test until the vectors are made again.
 */
export const Generator = Schema.Struct({
  commands: Schema.Array(Schema.Array(Schema.String)),
  links: Schema.Record(Schema.String, Schema.String),
  project: Schema.Record(Schema.String, Schema.String),
});

export type GeneratorFile = typeof Generator.Type;

/** The one way that the vectors are made. The assertion results are printed by the last command (`models check`). */
export const generator: GeneratorFile = {
  commands: [
    [
      "nix",
      "shell",
      "<effx>#alloy6",
      "-c",
      "bun",
      "<effx>/scripts/effx.ts",
      "build",
    ],
    [
      "nix",
      "shell",
      "<effx>#alloy6",
      "-c",
      "bun",
      "<effx>/scripts/effx.ts",
      "models",
      "check",
    ],
  ],
  links: { node_modules: "<effx>/node_modules" },
  project: {
    "effx.config.ts": `import { defineConfig } from "@effx/cli/config";
import { domainModel } from "@effx/domain-model";
import description from "./description.json" with { type: "json" };

export default defineConfig({
  models: { alloy: true },
  extensions: [domainModel(description as never)],
});
`,
    "entry.ts": "export const fixture = true;\n",
    "package.json": '{ "type": "module" }\n',
    "tsconfig.json":
      '{ "extends": "<effx>/tsconfig.json", "include": ["entry.ts"], "exclude": [] }\n',
  },
};

/** A recorded path or argument, with the checkout of effx put where `<effx>` stands. */
export const inCheckout = (text: string, effx: string): string =>
  text.replaceAll("<effx>", effx);

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
    commands: Schema.Int,
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
  generator: Generator,
});

export type ProvenanceFile = typeof Provenance.Type;

/** The provenance of one domain: what `regenerate` records and `drift` compares. */
export type DomainProvenanceFile = typeof DomainProvenance.Type;

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

/** The first line at which two texts differ, and what each text has there (`undefined` past its end). */
export const firstDifference = (
  have: string,
  want: string
): Option.Option<{
  readonly have: string | undefined;
  readonly line: number;
  readonly want: string | undefined;
}> => {
  const had = have.split("\n");
  const wanted = want.split("\n");

  return Option.map(
    Arr.findFirst(
      Arr.range(0, Math.max(had.length, wanted.length) - 1),
      (index) => had[index] !== wanted[index]
    ),
    (index) => ({ have: had[index], line: index + 1, want: wanted[index] })
  );
};

/**
 * What differs between the provenance of vectors that were made now and the committed one, a line for each domain that
 * is missing, is new, or differs: the first line at which its entry, as it is committed, differs. Empty when effx made
 * what is committed.
 */
export const differences = Effect.fn("differences")(function* differences(
  committed: Readonly<Record<string, DomainProvenanceFile>>,
  made: Readonly<Record<string, DomainProvenanceFile>>
) {
  const encode = Schema.encodeEffect(
    Schema.fromJsonString(DomainProvenance, { space: 2 })
  );

  const found = yield* Effect.forEach(
    Arr.dedupe([...Rec.keys(committed), ...Rec.keys(made)]),
    (domain) =>
      Effect.gen(function* one() {
        const had = committed[domain];
        const got = made[domain];

        if (had === undefined) {
          return [
            `${domain}: effx made vectors for a domain with none committed`,
          ];
        }

        if (got === undefined) {
          return [`${domain}: effx made no vectors for a committed domain`];
        }

        return Option.match(
          firstDifference(yield* encode(had), yield* encode(got)),
          {
            onNone: () => [],
            onSome: (line) => [
              `${domain}: line ${line.line} of its committed provenance is ${JSON.stringify(line.have)}, effx made ${JSON.stringify(line.want)}`,
            ],
          }
        );
      })
  );

  return Arr.flatten(found);
});
