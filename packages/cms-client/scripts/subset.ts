/**
 * Keeps the operations of EmDash's OpenAPI document that this repository calls, and the schemas they reach.
 * The same document and operation ids always give the same subset, so the committed `openapi/emdash.json` is a
 * function of EmDash's published contract.
 */
import {
  Array as Arr,
  Effect,
  Option,
  Record as Rec,
  Result,
  Schema,
} from "effect";

/** A map in an OpenAPI document: a path item, or one `components` section. */
const JsonMap = Schema.Record(Schema.String, Schema.Json);

/** `info`, `servers`, `security` and every other top-level key pass through unchanged. */
export const OpenApiDocument = Schema.StructWithRest(
  Schema.Struct({
    components: Schema.optionalKey(Schema.Record(Schema.String, JsonMap)),
    paths: Schema.Record(Schema.String, JsonMap),
  }),
  [JsonMap]
);

export type OpenApiDocument = typeof OpenApiDocument.Type;

interface OpenApiSubset {
  readonly document: OpenApiDocument;
  /** Operation ids the document does not offer. */
  readonly missing: readonly string[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

const isMethod = (key: string) => Arr.contains(HTTP_METHODS, key);

const decodeOperationId = Schema.decodeUnknownOption(
  Schema.Struct({ operationId: Schema.String })
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const REFERENCE =
  /"\$ref":"#\/components\/(?<section>[^/"]+)\/(?<name>[^"]+)"/gu;

/** Every `{ "$ref": "#/components/<section>/<name>" }` inside `value`, as `<section>/<name>`. */
const referencesIn = Effect.fn("referencesIn")(function* referencesIn(
  value: Schema.Json
) {
  const text = yield* encodeJson(value);

  return Arr.map(
    Arr.fromIterable(text.matchAll(REFERENCE)),
    (match) => `${match.groups?.section}/${match.groups?.name}`
  );
});

/** Transitive closure of `index` (component → components it references) from `roots`. */
const reachable = (
  index: Readonly<Record<string, readonly string[]>>,
  roots: readonly string[]
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue = [...roots];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(...(index[next] ?? []));
    }
  }

  return seen;
};

/**
 * The document reduced to `operationIds`: other operations and paths are dropped, and so is every component
 * (schema, response, parameter) that none of the kept operations reaches. Operation ids the document lacks come
 * back in `missing`, so the caller can refuse a document that no longer offers what the code calls.
 */
export const subsetOfOpenApi = Effect.fn("subsetOfOpenApi")(
  function* subsetOfOpenApi(
    { components = {}, paths, ...rest }: OpenApiDocument,
    operationIds: readonly string[]
  ) {
    const found = new Set<string>();

    const keptPaths = Rec.filterMap(paths, (item) => {
      const operations = Rec.filter(item, (operation, key) => {
        const id = decodeOperationId(operation);

        if (
          isMethod(key) &&
          Option.isSome(id) &&
          operationIds.includes(id.value.operationId)
        ) {
          found.add(id.value.operationId);

          return true;
        }

        // Path-level keys such as `parameters` stay.
        return !isMethod(key);
      });

      return Arr.some(HTTP_METHODS, (method) => method in operations)
        ? Result.succeed(operations)
        : Result.failVoid;
    });

    const index = Rec.fromEntries(
      yield* Effect.forEach(
        Arr.flatMap(Rec.toEntries(components), ([section, entries]) =>
          Arr.map(Rec.toEntries(entries), ([name, component]) => ({
            component,
            key: `${section}/${name}`,
          }))
        ),
        ({ component, key }) =>
          Effect.map(
            referencesIn(component),
            (references) => [key, references] as const
          )
      )
    );

    const reached = reachable(index, yield* referencesIn(keptPaths));

    const keptComponents = Rec.filterMap(
      components,
      (entries, section): Result.Result<Record<string, Schema.Json>, void> => {
        if (section === "securitySchemes") {
          return Result.succeed({ ...entries });
        }

        const kept = Rec.filter(entries, (_, name) =>
          reached.has(`${section}/${name}`)
        );

        return Rec.size(kept) > 0 ? Result.succeed(kept) : Result.failVoid;
      }
    );

    const subset: OpenApiSubset = {
      document: { ...rest, components: keptComponents, paths: keptPaths },
      missing: Arr.filter(operationIds, (id) => !found.has(id)),
    };

    return subset;
  }
);
