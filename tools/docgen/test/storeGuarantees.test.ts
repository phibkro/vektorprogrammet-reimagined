/**
 * Spec 0018, falsifier 9: `docs/system/store-guarantees.md` is the declaration, rendered. The committed page matches it;
 * a page with one generated character changed, and a declaration with one guarantee removed that the page still shows,
 * each fail the check.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { StoreGuarantees } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Result,
  String as Str,
} from "effect";

import {
  STORE,
  checkStoreGuaranteesDocument,
  renderStoreGuaranteesDocument,
} from "../src/storeGuarantees.ts";

const page = Effect.gen(function* page() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/store-guarantees.md");
}).pipe(Effect.provide(NodeServices.layer));

describe("store guarantees document (spec 0018)", () => {
  it.effect("falsifier 9: the committed page matches the declarations", () =>
    Effect.gen(function* committedPageMatches() {
      const text = yield* page;

      assert.isTrue(Result.isSuccess(checkStoreGuaranteesDocument(text)));
    })
  );

  it.effect(
    "falsifier 9: the page names every guarantee and the one exception",
    () =>
      Effect.gen(function* pageNamesThem() {
        const text = yield* page;

        for (const guarantee of StoreGuarantees) {
          assert.include(text, `| ${guarantee.id} |`);
        }

        assert.include(text, "exception: validity depends on time");
      })
  );

  it.effect(
    "falsifier 9, control: one changed character in a generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const text = yield* page;

        // The prose above the markers also says "store-enforced": the change is made inside the block.
        const block = Option.getOrElse(
          Str.indexOf("docgen:begin guarantees")(text),
          () => 0
        );

        const at =
          block +
          Option.getOrThrow(
            Str.indexOf("store-enforced")(Str.slice(block)(text))
          );

        const changed = `${Str.slice(0, at)(text)}Store-enforced${Str.slice(at + "store-enforced".length)(text)}`;

        assert.isTrue(Result.isFailure(checkStoreGuaranteesDocument(changed)));
      })
  );

  it.effect(
    "falsifier 9, control: a guarantee removed from the declaration, with the page left as it is, fails the check",
    () =>
      Effect.gen(function* removedGuarantee() {
        const text = yield* page;

        const without = {
          ...STORE,
          guarantees: Arr.filter(StoreGuarantees, ({ id }) => id !== "LK1"),
        };

        assert.isTrue(
          Result.isFailure(checkStoreGuaranteesDocument(text, without))
        );

        // Regenerated, the page drops the row: the document follows the declaration.
        const regenerated = renderStoreGuaranteesDocument(text, without);
        assert.isTrue(Result.isSuccess(regenerated));

        if (Result.isSuccess(regenerated)) {
          assert.notInclude(regenerated.success, "| LK1 |");
        }
      })
  );

  it.effect(
    "falsifier 9, control: a page without its markers is refused, not rewritten",
    () =>
      Effect.gen(function* withoutMarkers() {
        const text = Str.replaceAll(
          "<!-- docgen:begin modes -->",
          ""
        )(yield* page);

        assert.isTrue(Result.isFailure(renderStoreGuaranteesDocument(text)));
      })
  );
});
