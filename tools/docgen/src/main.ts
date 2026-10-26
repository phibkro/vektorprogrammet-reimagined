/** Generate or check the declaration-derived blocks in the system documentation. */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Declarations, GrantTable } from "@vektorprogrammet/domain";
import { Console, Effect, FileSystem, Result, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { checkDocument, renderDocument } from "./render.ts";

const FILE = "../../docs/system/teams.md";

// oxlint-disable unicorn/throw-new-error -- EX-0003: this is a Schema.TaggedError declaration, not a throw.
class DocumentationError extends Schema.TaggedError<
  DocumentationError,
  { readonly brand: unique symbol }
>()("DocumentationError", {
  message: Schema.String,
}) {}
// oxlint-enable unicorn/throw-new-error

const command = Command.make(
  "vektorprogrammet-docgen",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Fail if the generated blocks differ from the file"),
      Flag.withDefault(false)
    ),
  },
  Effect.fn(function* generate({ check }) {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(FILE);

    if (check) {
      const checked = checkDocument(source, Declarations, GrantTable);

      if (Result.isFailure(checked)) {
        return yield* new DocumentationError({ message: checked.failure });
      }

      return yield* Console.log(`${FILE}: generated blocks match`);
    }

    const generated = renderDocument(source, Declarations, GrantTable);

    if (Result.isFailure(generated)) {
      return yield* new DocumentationError({ message: generated.failure });
    }

    if (source !== generated.success) {
      yield* fs.writeFileString(FILE, generated.success);
    }

    return yield* Console.log(`${FILE}: generated blocks written`);
  })
);

NodeRuntime.runMain(
  command.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer)
  )
);
