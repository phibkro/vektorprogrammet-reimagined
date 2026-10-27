import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { Domain } from "@vektorprogrammet/domain";
import { Declarations, GrantTable, Teams } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, FileSystem, Result } from "effect";

import {
  checkAccountsDocument,
  checkDocument,
  renderDocument,
} from "../src/render.ts";

const source = Effect.gen(function* source() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/teams.md");
}).pipe(Effect.provide(NodeServices.layer));

describe("spec 0006 falsifier 8: generated documentation", () => {
  it.effect(
    "falsifier 8: the committed teams document matches the declarations",
    () =>
      Effect.gen(function* matches() {
        const document = yield* source;
        const checked = checkDocument(document, Declarations, GrantTable);
        assert.isTrue(Result.isSuccess(checked));
      })
  );

  it.effect(
    "falsifier 8, negative control: one changed character in a generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const document = yield* source;
        const changed = document.replace("| You are |", "| You ure |");
        assert.notStrictEqual(changed, document);
        assert.isTrue(
          Result.isFailure(checkDocument(changed, Declarations, GrantTable))
        );
      })
  );

  it.effect(
    "falsifier 8, negative control: removing one grant row without regenerating fails the check",
    () =>
      Effect.gen(function* removedGrant() {
        const document = yield* source;

        const reduced = Arr.filter(
          GrantTable,
          (row) => !Arr.contains(row.commands, "createTeam")
        );

        assert.isBelow(reduced.length, GrantTable.length);
        assert.isTrue(
          Result.isFailure(checkDocument(document, Declarations, reduced))
        );
      })
  );

  it.effect("incomplete declarations and invalid markers are refused", () =>
    Effect.gen(function* invalid() {
      const document = yield* source;

      const incomplete: Domain.Declaration = {
        ...Teams.TeamsDomain,
        table: [],
      };

      assert.isTrue(
        Result.isFailure(renderDocument(document, [incomplete], GrantTable))
      );
      const missing = document.replace("<!-- docgen:end who -->", "");
      assert.isTrue(
        Result.isFailure(renderDocument(missing, Declarations, GrantTable))
      );

      const nested = document.replace(
        "<!-- docgen:end who -->",
        "<!-- docgen:begin inner -->\n<!-- docgen:end who -->"
      );

      assert.isTrue(
        Result.isFailure(renderDocument(nested, Declarations, GrantTable))
      );
    })
  );
});

describe("spec 0007: generated account documentation", () => {
  it.effect(
    "the account reference matches its declaration, and removing its grant makes the check fail",
    () =>
      Effect.gen(function* accountReference() {
        const fs = yield* FileSystem.FileSystem;

        const document = yield* fs.readFileString(
          "../../docs/system/accounts.md"
        );

        assert.isTrue(
          Result.isSuccess(
            checkAccountsDocument(document, Declarations, GrantTable)
          )
        );

        const reduced = Arr.filter(
          GrantTable,
          (row) => !Arr.contains(row.commands, "activate")
        );

        assert.isBelow(reduced.length, GrantTable.length);
        assert.isTrue(
          Result.isFailure(
            checkAccountsDocument(document, Declarations, reduced)
          )
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
