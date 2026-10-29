/**
 * Spec 0025, falsifier 7: `docs/system/database-platforms.md` is the two declarations, rendered. The committed page matches
 * them; a page with one generated character changed, a construct that Hyperdrive now takes (a changed cell) and a recipe
 * with one more construct each fail the check, so the page cannot drift from what the adapter declares.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import {
  PLATFORMS,
  checkDatabasePlatformsDocument,
} from "../src/databasePlatforms.ts";
import type { PlatformDeclarations } from "../src/databasePlatforms.ts";

const page = Effect.gen(function* page() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/database-platforms.md");
}).pipe(Effect.provide(NodeServices.layer));

describe("database platforms document (spec 0025)", () => {
  it.effect("F7: the committed page matches the declarations", () =>
    Effect.gen(function* committedPageMatches() {
      assert.isTrue(
        Result.isSuccess(checkDatabasePlatformsDocument(yield* page))
      );
    })
  );

  it.effect(
    "F7: the page says what only a direct connection has, and marks the pg-txmode column unmerged",
    () =>
      Effect.gen(function* pageNamesThem() {
        const text = yield* page;

        for (const construct of PLATFORMS.directOnly) {
          assert.include(text, `\`${construct}\``);
        }

        assert.include(text, "`pg-txmode` row (unmerged)");
        assert.include(text, "lock-excludes-second-holder");
      })
  );

  it.effect(
    "F7, control: one changed character in a generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const text = yield* page;

        const at = text.indexOf(
          "unsupported",
          text.indexOf("docgen:begin direct-only")
        );

        assert.isAbove(at, 0);

        const changed = `${text.slice(0, at)}Unsupported${text.slice(at + "unsupported".length)}`;

        assert.isTrue(
          Result.isFailure(checkDatabasePlatformsDocument(changed))
        );
      })
  );

  it.effect(
    "F7, control: a cell that changes in the declaration, and a construct that a recipe adds, each fail the check",
    () =>
      Effect.gen(function* changedDeclaration() {
        const text = yield* page;

        const taken: PlatformDeclarations = {
          ...PLATFORMS,
          facts: {
            ...PLATFORMS.facts,
            "advisory-lock-session": {
              ...PLATFORMS.facts["advisory-lock-session"],
              hyperdrive: {
                how: "unverified",
                note: "a changed cell",
                outcome: "works",
              },
            },
          },
        };

        assert.isTrue(
          Result.isFailure(checkDatabasePlatformsDocument(text, taken))
        );

        const widened: PlatformDeclarations = {
          ...PLATFORMS,
          recipes: {
            ...PLATFORMS.recipes,
            Snapshots: [...PLATFORMS.recipes.Snapshots, "savepoint"],
          },
        };

        assert.isTrue(
          Result.isFailure(checkDatabasePlatformsDocument(text, widened))
        );
      })
  );
});
