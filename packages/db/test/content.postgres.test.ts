import { assert, layer } from "@effect/vitest";
import { CmsClient, ContentEditor } from "@vektorprogrammet/domain/cms";
import { Array as Arr, Effect, Layer, Option } from "effect";

import { ContentLive } from "../src/content.ts";
import { postgresDatabase } from "./support/database.ts";

layer(ContentLive.pipe(Layer.provideMerge(postgresDatabase())), {
  excludeTestServices: true,
})("content publication", (it) => {
  it.effect("RULE-267: drafts never leak and publishing copies the draft", () =>
    Effect.gen(function* draftPublication() {
      const editor = yield* ContentEditor;
      const content = yield* CmsClient;
      yield* editor.create("texts", "publication-test", {
        content: [],
        title: "Original",
      });
      assert.isTrue(
        Option.isNone(yield* content.texts.publishedBySlug("publication-test"))
      );
      yield* editor.publish("texts", "publication-test");
      yield* editor.save("texts", "publication-test", {
        content: [],
        title: "Draft",
      });
      const first = yield* content.texts.publishedBySlug("publication-test");
      assert.strictEqual(Option.getOrThrow(first).data.title, "Original");
      yield* editor.publish("texts", "publication-test");
      const second = yield* content.texts.publishedBySlug("publication-test");
      assert.strictEqual(Option.getOrThrow(second).data.title, "Draft");

      const duplicate = yield* editor
        .create("texts", "publication-test", { title: "Other" })
        .pipe(Effect.flip);

      assert.strictEqual(duplicate._tag, "CmsRejected");

      const draft = {
        content: [
          {
            _type: "block",
            children: [{ _type: "span", extraSpan: [1, 2], text: "Hello" }],
            extraBlock: 7,
          },
        ],
        extra: { enabled: true },
        title: "With extras",
      };

      yield* editor.save("texts", "publication-test", draft);

      const saved = Option.getOrThrow(
        Arr.findFirst(
          yield* editor.list,
          (row) => row.slug === "publication-test"
        )
      );

      assert.deepStrictEqual(saved?.draft, draft);
      assert.strictEqual(
        Option.getOrThrow(
          yield* content.texts.publishedBySlug("publication-test")
        ).data.title,
        "Draft"
      );
      yield* editor.publish("texts", "publication-test");
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* content.texts.publishedBySlug("publication-test")
        ).data,
        draft
      );

      const invalid = yield* editor
        .save("texts", "publication-test", { title: 42 })
        .pipe(Effect.flip);

      assert.strictEqual(invalid._tag, "CmsInvalidContent");
      assert.deepStrictEqual(
        Option.getOrThrow(
          Arr.findFirst(
            yield* editor.list,
            (row) => row.slug === "publication-test"
          )
        )?.draft,
        draft
      );
    })
  );
});
