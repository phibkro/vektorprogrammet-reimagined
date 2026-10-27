/**
 * Spec 0007d, regeneration: hand each description to effx's own tooling at the pinned commit, on the pinned Alloy, and
 * keep what effx makes. Nothing is written unless effx accepts every description and every assertion passes, so a
 * failing run leaves the committed files as they were. The files are written, in order: descriptions, vectors, the
 * register of gaps and the provenance.
 */
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
  Path,
  Record as Rec,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  ArtefactFailed,
  Pin,
  Provenance,
  descriptionFile,
  directory,
  gapsFile,
  gzip,
  pinFile,
  provenanceFile,
  readJson,
  sha256Hex,
  utf8,
  vectorsFile,
} from "./artefacts.ts";
import { derive } from "./generate.ts";
import { Vectors, countRows } from "./vectors.ts";

/** A program to its end: its standard output as text, its standard error shown, a failure when it exits with a code. */
const run = Effect.fn("run")(function* run(
  command: string,
  args: readonly string[],
  cwd: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* child() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd,
          extendEnv: true,
          stderr: "inherit",
          stdin: "ignore",
        })
      );

      const [stdout, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" }
      );

      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        yield* Console.error(stdout);

        return yield* new ArtefactFailed({
          message: `${command} ${Arr.join(args, " ")} exited with ${exitCode}`,
        });
      }

      return stdout;
    })
  );
});

const Lock = Schema.Struct({
  nodes: Schema.Struct({
    nixpkgs: Schema.Struct({ locked: Schema.Struct({ rev: Schema.String }) }),
  }),
});

const ASSERTION =
  /^(?<domain>\S+) (?<name>A\d+_\w+)(?: (?<subject>\S+))? (?<result>PASS|NOT APPLICABLE)\b/u;

/** The assertion lines that effx printed for one domain, by the name of the assertion and what it was asked about. */
const assertionsOf = (domain: string, output: string) =>
  Arr.flatMap(output.split("\n"), (line) => {
    const found = ASSERTION.exec(line)?.groups;
    const name = found?.name;

    if (found?.domain !== domain || name === undefined) {
      return [];
    }

    const { subject } = found;

    return [
      {
        name: subject === undefined ? name : `${name} ${subject}`,
        result:
          found.result === "PASS"
            ? ("PASS" as const)
            : ("NOT APPLICABLE" as const),
      },
    ];
  });

const config = `import { defineConfig } from "@effx/cli/config";
import { domainModel } from "@effx/domain-model";
import description from "./description.json" with { type: "json" };

export default defineConfig({
  models: { alloy: true },
  extensions: [domainModel(description as never)],
});
`;

export const regenerate = Effect.fn("regenerate")(function* regenerate() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pin = yield* readJson(Pin, pinFile);
  const effx = yield* Config.String("EFFX_DIR");

  // The checkout is the pinned commit, with no change to a tracked file.
  const head = (yield* run(
    "git",
    ["-C", effx, "rev-parse", "HEAD"],
    "."
  )).trim();

  const changed = (yield* run(
    "git",
    ["-C", effx, "status", "--porcelain", "--untracked-files=no"],
    "."
  )).trim();

  if (head !== pin.commit || changed !== "") {
    return yield* new ArtefactFailed({
      message: `EFFX_DIR must be a clean checkout of ${pin.repository} at ${pin.commit} (HEAD ${head}${changed === "" ? "" : ", with local changes"})`,
    });
  }

  const nix = (...args: readonly string[]) => [
    "shell",
    `${effx}#alloy6`,
    "-c",
    ...args,
  ];

  const alloyVersion = (yield* run(
    "nix",
    nix("alloy6", "version"),
    "."
  )).trim();

  if (alloyVersion !== pin.alloy) {
    return yield* new ArtefactFailed({
      message: `Alloy ${alloyVersion} is not the pinned ${pin.alloy}`,
    });
  }

  const executable = (yield* run(
    "nix",
    nix("sh", "-c", 'readlink -f "$(command -v alloy6)"'),
    "."
  )).trim();

  const nixpkgs = (yield* readJson(Lock, path.join(effx, "flake.lock"))).nodes
    .nixpkgs.locked.rev;

  const derived = yield* derive();

  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "effx-conformance-",
  });

  const made = yield* Effect.forEach(
    derived.descriptions,
    ({ description, domain, text }) =>
      Effect.gen(function* one() {
        const project = path.join(root, domain);
        yield* fs.makeDirectory(project, { recursive: true });
        yield* fs.writeFileString(path.join(project, "description.json"), text);
        yield* fs.writeFileString(
          path.join(project, "entry.ts"),
          "export const fixture = true;\n"
        );
        yield* fs.writeFileString(
          path.join(project, "tsconfig.json"),
          `{ "extends": "${path.join(effx, "tsconfig.json")}", "include": ["entry.ts"], "exclude": [] }\n`
        );
        yield* fs.writeFileString(path.join(project, "effx.config.ts"), config);
        yield* fs.writeFileString(
          path.join(project, "package.json"),
          '{ "type": "module" }\n'
        );
        // effx analyses the project and resolves `effect` from it: the checkout's own dependencies are the project's.
        yield* fs.symlink(
          path.join(effx, "node_modules"),
          path.join(project, "node_modules")
        );

        const cli = (...args: readonly string[]) =>
          run(
            "nix",
            nix("bun", path.join(effx, "scripts", "effx.ts"), ...args),
            project
          );

        yield* Console.log(`${domain}: effx build`);
        yield* cli("build");
        yield* Console.log(`${domain}: effx models check`);
        const output = yield* cli("models", "check");

        const bytes = yield* fs.readFile(
          path.join(
            project,
            ".effx",
            "models",
            "alloy",
            `${domain}.vectors.json`
          )
        );

        const vectors = yield* Schema.decodeEffect(
          Schema.fromJsonString(Vectors)
        )(new TextDecoder().decode(bytes));

        const assertions = assertionsOf(domain, output);

        if (Arr.isReadonlyArrayEmpty(assertions)) {
          return yield* new ArtefactFailed({
            message: `${domain}: effx printed no assertion result that this tool reads`,
          });
        }

        return {
          compressed: yield* gzip(bytes),
          domain,
          provenance: {
            assertions,
            descriptionSha256: yield* sha256Hex(utf8(text)),
            instances: vectors.instances.length,
            nondeterministic: vectors.nondeterministic,
            orderedAtoms: vectors.orderedAtoms,
            rows: countRows(
              vectors,
              Arr.map(
                description.machines,
                ({ name, states, transitions }) => ({
                  name,
                  states: states.length,
                  transitions: transitions.length,
                })
              )
            ),
            scope: vectors.scope,
            steps: vectors.steps,
            unknownGuards: vectors.unknownGuards,
            vectorsSha256: yield* sha256Hex(bytes),
          },
          text,
        };
      })
  );

  const provenance = yield* Schema.encodeEffect(
    Schema.fromJsonString(Provenance, { space: 2 })
  )({
    alloy: { executable, version: alloyVersion },
    domains: Rec.fromEntries(
      Arr.map(made, ({ domain, provenance: found }) => [domain, found])
    ),
    effx: { commit: pin.commit, nixpkgs, repository: pin.repository },
  });

  // Everything is made; now the committed files change, together.
  const stale = Arr.filter(
    yield* fs.readDirectory(directory),
    (name) =>
      (name.endsWith(".description.json") ||
        name.endsWith(".vectors.json.gz")) &&
      !Arr.some(made, ({ domain }) => name.startsWith(`${domain}.`))
  );

  yield* Effect.forEach(
    stale,
    (name) => fs.remove(path.join(directory, name)),
    {
      discard: true,
    }
  );

  yield* Effect.forEach(
    made,
    ({ compressed, domain, text }) =>
      Effect.all(
        [
          fs.writeFileString(descriptionFile(domain), text),
          fs.writeFile(vectorsFile(domain), compressed),
        ],
        { discard: true }
      ),
    { discard: true }
  );

  yield* fs.writeFileString(gapsFile, derived.gaps);
  yield* fs.writeFileString(provenanceFile, `${provenance}\n`);

  return yield* Console.log(
    `regenerated ${Arr.join(
      Arr.map(made, ({ domain }) => domain),
      ", "
    )} with effx ${pin.commit}`
  );
}, Effect.scoped);
