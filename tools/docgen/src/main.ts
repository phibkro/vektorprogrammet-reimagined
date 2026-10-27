/** Generate or check the declaration-derived blocks in the system documentation. */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Declarations, GrantTable } from "@vektorprogrammet/domain";
import { Console, Effect, FileSystem, Result, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import {
  checkAccountsDocument,
  checkAdministrationDocument,
  checkCommandsDocument,
  checkDocument,
  renderAccountsDocument,
  renderAdministrationDocument,
  renderCommandsDocument,
  renderDocument,
} from "./render.ts";

const DOCUMENTS = [
  {
    check: checkDocument,
    file: "../../docs/system/teams.md",
    render: renderDocument,
  },
  {
    check: checkAccountsDocument,
    file: "../../docs/system/accounts.md",
    render: renderAccountsDocument,
  },
  {
    check: checkCommandsDocument,
    file: "../../docs/system/commands.md",
    render: renderCommandsDocument,
  },
  {
    check: checkAdministrationDocument,
    file: "../../docs/system/administration.md",
    render: renderAdministrationDocument,
  },
] as const;

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

    for (const document of DOCUMENTS) {
      const source = yield* fs.readFileString(document.file);

      if (check) {
        const checked = document.check(source, Declarations, GrantTable);

        if (Result.isFailure(checked)) {
          return yield* new DocumentationError({ message: checked.failure });
        }

        yield* Console.log(`${document.file}: generated blocks match`);
      } else {
        const generated = document.render(source, Declarations, GrantTable);

        if (Result.isFailure(generated)) {
          return yield* new DocumentationError({ message: generated.failure });
        }

        if (source !== generated.success) {
          yield* fs.writeFileString(document.file, generated.success);
        }

        yield* Console.log(`${document.file}: generated blocks written`);
      }
    }

    return yield* Effect.void;
  })
);

NodeRuntime.runMain(
  command.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer)
  )
);
