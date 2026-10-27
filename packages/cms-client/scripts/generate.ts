/**
 * `bun run generate [--spec <file>]`: regenerates the typed EmDash client.
 *
 *   EmDash's OpenAPI document (`GET /_emdash/api/openapi.json`, needs a token)
 *     → the operations this repository calls (`subsetOfOpenApi`) → `openapi/emdash.json`
 *     → `@effect/openapi-generator` (Effect HttpClient + Schema) → `src/generated.ts`
 *
 * Without `--spec` it regenerates from the committed subset, which proves the generated file is a function of it.
 * To follow an EmDash upgrade, save the new full document (README § Regenerating the client) and pass it.
 */
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schema,
} from "effect";
import { Command, Flag } from "effect/cli";
import type { OpenAPISpec } from "effect/http-api/OpenApi";

import { finiteNumbers } from "./finiteNumbers.ts";
import { OpenApiDocument, subsetOfOpenApi } from "./subset.ts";

/** The operations `apps/web` (read) and `tools/import` (write) call. */
const OPERATIONS = [
  "listContent",
  "getContent",
  "createContent",
  "publishContent",
] as const;

class GenerateFailed extends Schema.TaggedError<
  GenerateFailed,
  { readonly brand: unique symbol }
>()("GenerateFailed", {
  reason: Schema.String,
  source: Schema.String,
}) {}

const packageRoot = new URL("..", import.meta.url).pathname;

const spec = Flag.String("spec").pipe(
  Flag.withDescription(
    "EmDash's OpenAPI document (full, or the committed subset); default openapi/emdash.json"
  ),
  Flag.withDefault("openapi/emdash.json")
);

const DocumentFile = Schema.fromJsonString(OpenApiDocument, { space: 2 });

/** An OpenAPI 3 document: the generator reads `openapi`, `info`, `paths` and `components`. */
const isOpenApiSpec = (
  document: OpenApiDocument
): document is OpenApiDocument & OpenAPISpec =>
  Predicate.isString(document.openapi) &&
  Predicate.hasProperty(document, "info");

const command = Command.make(
  "generate",
  { spec },
  Effect.fn(function* generate(flags) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const input = path.resolve(packageRoot, flags.spec);

    const document = yield* Schema.decodeEffect(DocumentFile)(
      yield* fs.readFileString(input)
    );

    const { document: subset, missing } = yield* subsetOfOpenApi(
      document,
      OPERATIONS
    );

    if (missing.length > 0) {
      return yield* new GenerateFailed({
        reason: `the document lacks the operations ${Arr.join(missing, ", ")}`,
        source: input,
      });
    }

    if (!isOpenApiSpec(subset)) {
      return yield* new GenerateFailed({
        reason: "the document is not an OpenAPI 3 document",
        source: input,
      });
    }

    const generator = yield* OpenApiGenerator.OpenApiGenerator;
    const warnings: string[] = [];

    const source = yield* generator.generate(subset, {
      format: "httpclient",
      name: "EmDash",
      onWarning: (warning) => {
        warnings.push(`warning [${warning.code}]: ${warning.message}`);
      },
    });

    yield* Effect.forEach(warnings, (line) => Console.error(line), {
      discard: true,
    });

    yield* fs.writeFileString(
      path.join(packageRoot, "openapi/emdash.json"),
      `${yield* Schema.encodeEffect(DocumentFile)(subset)}\n`
    );

    yield* fs.writeFileString(
      path.join(packageRoot, "src/generated.ts"),
      finiteNumbers(source)
    );

    return yield* Console.log(
      `generated ${Arr.length(OPERATIONS)} operations from ${input}`
    );
  })
);

NodeRuntime.runMain(
  command.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(
      Layer.mergeAll(
        OpenApiGenerator.layerTransformerSchema,
        NodeServices.layer
      )
    )
  )
);
