import { assert, layer } from "@effect/vitest";
import { CmsClient, ContentEditor } from "@vektorprogrammet/domain/cms";
import { Effect, Layer, Option } from "effect";

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
    })
  );
});
