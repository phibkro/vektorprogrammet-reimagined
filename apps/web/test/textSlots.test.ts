/**
 * The pages name the text slots they show (`src/lib/textSlots.ts`); the CMS seed (`apps/cms/seed/seed.json`)
 * carries the default copy that a development, preview or browser-test stage starts with. This test keeps the two
 * in step, so a slot a page shows is never silently empty, and checks the copy is valid content for the client.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { FaqData, PortableText, TextData } from "@vektorprogrammet/cms-client";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Order,
  Path,
  Record as Rec,
  Schema,
} from "effect";

import { ALL_TEXT_SLOTS } from "../src/lib/textSlots";

const SeedFile = Schema.fromJsonString(
  Schema.Struct({
    content: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          data: Schema.Unknown,
          id: Schema.String,
          slug: Schema.String,
          status: Schema.Literal("published"),
        })
      )
    ),
  })
);

const readSeed = Effect.gen(function* readSeed() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* Schema.decodeEffect(SeedFile)(
    yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("../../cms/seed/seed.json", import.meta.url)
      )
    )
  );
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Legacy blocks whose copy only the organisation's editors have: mono-web has no text for them, so the seed has
 * none either, and a slot with no published text renders nothing.
 */
const WITHOUT_DEFAULT_COPY = ["about-faq", "vektor_i_media"];

const sorted = (values: readonly string[]) => Arr.sort(values, Order.String);

describe("the default copy of the CMS seed", () => {
  it.effect(
    "has a text for every slot a page shows, except the ones only editors can write, and no text for a slot no page shows",
    () =>
      Effect.gen(function* slotsHaveCopy() {
        const { content } = yield* readSeed;

        const copied = Arr.map(content.texts ?? [], (entry) => entry.slug);

        assert.deepStrictEqual(
          sorted(copied),
          sorted(Arr.difference(ALL_TEXT_SLOTS, WITHOUT_DEFAULT_COPY))
        );
      })
  );

  it.effect(
    "is valid content: every text decodes as a text, made of text blocks, and every question as a question",
    () =>
      Effect.gen(function* copyIsValid() {
        const { content } = yield* readSeed;

        for (const entry of content.texts ?? []) {
          const text = yield* Schema.decodeUnknownEffect(TextData)(entry.data);

          assert.isTrue(
            Arr.every(text.content ?? [], Schema.is(PortableText.TextBlock)),
            entry.slug
          );
          assert.isAbove(text.content?.length ?? 0, 0, entry.slug);
        }

        for (const entry of content.faq ?? []) {
          yield* Schema.decodeUnknownEffect(FaqData)(entry.data);
        }
      })
  );

  it.effect(
    "holds nine questions for Assistenter and four for Team, numbered from one",
    () =>
      Effect.gen(function* faqCopy() {
        const { content } = yield* readSeed;

        const entries = yield* Effect.forEach(content.faq ?? [], (entry) =>
          Schema.decodeUnknownEffect(FaqData)(entry.data)
        );

        const positionsOf = (page: "assistenter" | "team") =>
          Arr.map(
            Arr.filter(entries, (entry) => entry.page === page),
            (entry) => entry.position
          );

        assert.deepStrictEqual(positionsOf("assistenter"), Arr.range(1, 9));
        assert.deepStrictEqual(positionsOf("team"), Arr.range(1, 4));
      })
  );

  it.effect(
    "is texts and questions only: no invented teams, people, sponsors or news",
    () =>
      Effect.gen(function* onlyTextsAndQuestions() {
        const { content } = yield* readSeed;

        assert.deepStrictEqual(sorted(Rec.keys(content)), ["faq", "texts"]);
      })
  );
});
