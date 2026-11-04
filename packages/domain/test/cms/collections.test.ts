import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { COLLECTIONS } from "../../src/cms/index.ts";

describe("site content schemas", () => {
  it("accepts valid collection data and rejects a malformed news item", () => {
    assert.isTrue(
      Schema.is(COLLECTIONS.texts)({ content: [], title: "Velkommen" })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.news)({ sticky: true, title: "Nyhet" })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.sponsors)({
        name: "Partner",
        size: "small",
        url: "https://example.org",
      })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.faq)({
        answer: "Svar",
        page: "team",
        position: 1,
        question: "Hva?",
      })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.teams)({
        department: "Oslo",
        name: "Team",
        position: 1,
      })
    );
    assert.isFalse(Schema.is(COLLECTIONS.news)({ title: 42 }));
  });

  it.effect("retains extra JSON while validating known fields", () =>
    Effect.gen(function* preservesExtras() {
      const input = {
        extra: [true],
        image: { focal: { x: 1 }, id: "image" },
        title: "News",
      };

      const codec = Schema.toCodecJson(COLLECTIONS.news);
      const decode = Schema.decodeEffect(codec);
      const decoded = yield* decode(input);
      assert.deepStrictEqual(decoded, input);
      assert.deepStrictEqual(yield* Schema.encodeEffect(codec)(decoded), input);
      yield* Effect.flip(decode({ extra: true, title: 42 }));
      yield* Effect.flip(
        decode({
          content: [
            { _type: "block", children: [{ _type: "span", text: 42 }] },
          ],
          title: "Bad",
        })
      );
      yield* Effect.flip(
        Schema.decodeUnknownEffect(codec)({ extra: () => 1, title: "Bad" })
      );

      const unknown = {
        content: [{ _type: "custom", value: 1 }],
        title: "Unknown",
      };

      assert.deepStrictEqual(yield* decode(unknown), unknown);
      yield* Effect.flip(
        decode({ image: { extra: true, id: 42 }, title: "News" })
      );
    })
  );
});
