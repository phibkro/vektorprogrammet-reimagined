import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order, Record as Rec, Schema } from "effect";

import { OpenApiDocument, subsetOfOpenApi } from "../scripts/subset.ts";

const decode = Schema.decodeEffect(
  Schema.fromJsonString(OpenApiDocument, { space: 0 })
);

const DOCUMENT = `{
  "openapi": "3.1.0",
  "info": { "title": "Fake", "version": "1" },
  "paths": {
    "/things/{id}": {
      "parameters": [{ "$ref": "#/components/parameters/IdParam" }],
      "get": {
        "operationId": "getThing",
        "responses": { "200": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Thing" } } } } }
      },
      "delete": { "operationId": "deleteThing", "responses": { "200": { "description": "gone" } } }
    },
    "/others": {
      "post": {
        "operationId": "createOther",
        "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Other" } } } },
        "responses": { "201": { "description": "made" } }
      }
    }
  },
  "components": {
    "parameters": { "IdParam": { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } } },
    "schemas": {
      "Thing": { "type": "object", "properties": { "part": { "$ref": "#/components/schemas/Part" } } },
      "Part": { "type": "object" },
      "Other": { "type": "object" },
      "Unused": { "type": "object" }
    },
    "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" }, "session": { "type": "apiKey" } }
  }
}`;

const sortedKeys = (
  record: Readonly<Record<string, Schema.Json>> | undefined
) => Arr.sort(Rec.keys(record ?? {}), Order.String);

describe("subsetOfOpenApi", () => {
  it.effect(
    "keeps the named operations and drops the rest, with their paths",
    () =>
      Effect.gen(function* keepsOperations() {
        const { document, missing } = yield* subsetOfOpenApi(
          yield* decode(DOCUMENT),
          ["getThing"]
        );

        assert.deepStrictEqual(missing, []);
        assert.deepStrictEqual(sortedKeys(document.paths), ["/things/{id}"]);
        assert.deepStrictEqual(sortedKeys(document.paths["/things/{id}"]), [
          "get",
          "parameters",
        ]);
      })
  );

  it.effect(
    "keeps only the components the kept operations reach, transitively",
    () =>
      Effect.gen(function* prunesComponents() {
        const { document } = yield* subsetOfOpenApi(yield* decode(DOCUMENT), [
          "getThing",
        ]);

        assert.deepStrictEqual(sortedKeys(document.components?.schemas), [
          "Part",
          "Thing",
        ]);
        assert.deepStrictEqual(sortedKeys(document.components?.parameters), [
          "IdParam",
        ]);
      })
  );

  it.effect(
    "keeps every security scheme, which no operation references by $ref",
    () =>
      Effect.gen(function* keepsSecurity() {
        const { document } = yield* subsetOfOpenApi(yield* decode(DOCUMENT), [
          "createOther",
        ]);

        assert.deepStrictEqual(
          sortedKeys(document.components?.securitySchemes),
          ["bearer", "session"]
        );
        assert.deepStrictEqual(sortedKeys(document.components?.schemas), [
          "Other",
        ]);
      })
  );

  it.effect(
    "passes the other top-level keys through and names operations the document lacks",
    () =>
      Effect.gen(function* reportsMissing() {
        const { document, missing } = yield* subsetOfOpenApi(
          yield* decode(DOCUMENT),
          ["getThing", "noSuchOperation"]
        );

        assert.deepStrictEqual(missing, ["noSuchOperation"]);
        assert.strictEqual(document.openapi, "3.1.0");
      })
  );
});
