/**
 * Spec 0007d. `generate` writes the descriptions and the register of gaps that the kernel's declarations give, and
 * nothing that effx makes. `regenerate` also hands every description to effx at the pinned commit and keeps its
 * vectors (`EFFX_DIR` names a clean, installed checkout of that commit; it needs Nix for Alloy).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array as Arr, Console, Effect, FileSystem, Path } from "effect";
import { Command } from "effect/cli";

import { descriptionFile, directory, gapsFile } from "./artefacts.ts";
import { derive } from "./generate.ts";
import { regenerate } from "./regenerate.ts";

const generate = Command.make(
  "generate",
  {},
  Effect.fn(function* generate() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const derived = yield* derive();

    const stale = Arr.filter(
      yield* fs.readDirectory(directory),
      (name) =>
        name.endsWith(".description.json") &&
        !Arr.some(
          derived.descriptions,
          ({ domain }) => name === `${domain}.description.json`
        )
    );

    yield* Effect.forEach(
      stale,
      (name) => fs.remove(path.join(directory, name)),
      { discard: true }
    );

    yield* Effect.forEach(
      derived.descriptions,
      ({ domain, text }) => fs.writeFileString(descriptionFile(domain), text),
      { discard: true }
    );

    yield* fs.writeFileString(gapsFile, derived.gaps);
    yield* Console.log(
      `${Arr.length(derived.descriptions)} descriptions and the register of gaps written`
    );
  })
).pipe(
  Command.withDescription(
    "Write the descriptions and the register of gaps that the declarations give (the vectors stay as they are)"
  )
);

const regeneration = Command.make("regenerate", {}, regenerate).pipe(
  Command.withDescription(
    "Write them, make the vectors with effx at the pinned commit (EFFX_DIR), and write the provenance"
  )
);

NodeRuntime.runMain(
  Command.make("vektorprogrammet-effx-conformance").pipe(
    Command.withSubcommands([generate, regeneration]),
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer)
  )
);
