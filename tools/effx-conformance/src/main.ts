/**
 * Spec 0007d. `generate` writes the descriptions and the register of gaps that the kernel's declarations give, and
 * nothing that effx makes. `regenerate` also hands every description to effx at the pinned commit and keeps its
 * vectors (`EFFX_DIR` names a clean, installed checkout of that commit; it needs Nix for Alloy). `drift` makes the
 * vectors with the checkout of effx that `EFFX_DIR` names, at any commit, and writes nothing: it fails when they are
 * not the committed ones (gate G2, the weekly check of `.github/workflows/effx-drift.yml`).
 */
import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  String as Str,
} from "effect";
import { Command } from "effect/cli";

import { descriptionFile, directory, gapsFile } from "./artefacts.ts";
import { derive } from "./generate.ts";
import { drift, regenerate } from "./regenerate.ts";

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
        Str.endsWith(".description.json")(name) &&
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

const drifting = Command.make("drift", {}, drift).pipe(
  Command.withDescription(
    "Make the vectors with the checkout of effx that EFFX_DIR names, at any commit, and fail when they are not the committed ones (writes nothing)"
  )
);

NodeRuntime.runMain(
  Command.make("vektorprogrammet-effx-conformance").pipe(
    Command.withSubcommands([generate, regeneration, drifting]),
    Command.run({ version: "0.0.0" }),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest))
  )
);
