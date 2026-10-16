import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Record as Rec,
  Schema,
  SchemaAST,
} from "effect";

import { COLLECTIONS, NewsData, SponsorData, TextData } from "../src/index.ts";

const SeedCollection = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      required: Schema.optionalKey(Schema.Boolean),
      slug: Schema.String,
    })
  ),
  slug: Schema.String,
});

const SeedFile = Schema.fromJsonString(
  Schema.Struct({ collections: Schema.Array(SeedCollection) })
);

const readSeed = Effect.gen(function* readSeed() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* Schema.decodeEffect(SeedFile)(
    yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("../../../apps/cms/seed/seed.json", import.meta.url)
      )
    )
  );
});

const sorted = (values: readonly string[]) => Arr.sort(values, Order.String);

const schemas: Readonly<
  Record<string, { readonly fields: Schema.Struct.Fields }>
> = COLLECTIONS;

/** How one seed collection and its schema disagree, as sentences; none when they describe the same fields. */
const disagreements = (
  collection: typeof SeedCollection.Type
): readonly string[] => {
  const fields = Option.match(Rec.get(schemas, collection.slug), {
    onNone: () => ({}),
    onSome: (schema) => schema.fields,
  });

  const seedSlugs = Arr.map(collection.fields, (field) => field.slug);
  const schemaSlugs = Rec.keys(fields);

  return [
    ...Arr.map(
      Arr.difference(seedSlugs, schemaSlugs),
      (slug) => `${collection.slug}.${slug} is in the seed, not in the schema`
    ),
    ...Arr.map(
      Arr.difference(schemaSlugs, seedSlugs),
      (slug) => `${collection.slug}.${slug} is in the schema, not in the seed`
    ),
    ...Arr.flatMap(collection.fields, (field) =>
      Option.match(Rec.get(fields, field.slug), {
        onNone: () => [],
        onSome: (schemaField) =>
          SchemaAST.isOptional(schemaField.ast) === (field.required === true)
            ? [
                `${collection.slug}.${field.slug} is ${field.required === true ? "required" : "optional"} in the seed and the other way round in the schema`,
              ]
            : [],
      })
    ),
  ];
};

describe("the seed and the schemas describe the same collections", () => {
  it.effect("every seed collection has a schema, and the other way round", () =>
    Effect.gen(function* sameCollections() {
      const seed = yield* readSeed;

      assert.deepStrictEqual(
        sorted(Arr.map(seed.collections, (collection) => collection.slug)),
        sorted(Rec.keys(schemas))
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "every seed field is a schema key and the reverse, and a required one is required",
    () =>
      Effect.gen(function* sameFields() {
        const seed = yield* readSeed;

        assert.deepStrictEqual(
          Arr.flatMap(seed.collections, disagreements),
          []
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("collection data as EmDash answers it", () => {
  const news = Schema.toCodecJson(NewsData);
  const decodeNews = Schema.decodeUnknownEffect(news);

  it.effect(
    "a boolean read back as 1 or 0 is a boolean, and a field never set is absent",
    () =>
      Effect.gen(function* readsBooleans() {
        const sticky = yield* decodeNews({ sticky: 1, title: "A" });
        const plain = yield* decodeNews({ sticky: 0, title: "B" });
        const unset = yield* decodeNews({ title: "C" });

        assert.deepStrictEqual(
          [sticky.sticky, plain.sticky, unset.sticky],
          [true, false, undefined]
        );
      })
  );

  it.effect(
    "accepts a boolean that is already one, and null for a field that was cleared",
    () =>
      Effect.gen(function* readsClearedFields() {
        const cleared = yield* decodeNews({
          departments: null,
          image: null,
          sticky: true,
          title: "A",
        });

        assert.deepStrictEqual(
          [cleared.sticky, cleared.departments, cleared.image],
          [true, null, null]
        );
      })
  );

  it.effect(
    "keeps the Portable Text of an article, marks and links included, through a round trip",
    () =>
      Effect.gen(function* roundTripsPortableText() {
        const input = {
          content: [
            {
              _key: "a",
              _type: "block",
              children: [
                {
                  _key: "s",
                  _type: "span",
                  marks: ["strong", "k1"],
                  text: "Hei",
                },
              ],
              markDefs: [
                { _key: "k1", _type: "link", href: "https://example.org" },
              ],
              style: "normal",
            },
          ],
          title: "A",
        };

        assert.deepStrictEqual(
          yield* Schema.encodeEffect(news)(yield* decodeNews(input)),
          input
        );
      })
  );

  it.effect(
    "refuses a sponsor size the CMS does not offer, and a text without a title",
    () =>
      Effect.gen(function* refusesUnknown() {
        const decodeSponsor = Schema.decodeUnknownEffect(
          Schema.toCodecJson(SponsorData)
        );

        const decodeText = Schema.decodeUnknownEffect(
          Schema.toCodecJson(TextData)
        );

        const badSize = yield* Effect.flip(
          decodeSponsor({ name: "N", size: "huge", url: "https://example.org" })
        );

        const noTitle = yield* Effect.flip(decodeText({ content: [] }));

        assert.isTrue(badSize.message.includes("size"));
        assert.isTrue(noTitle.message.includes("title"));
      })
  );
});
