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
  differences,
  directory,
  gapsFile,
  generator,
  gzip,
  inCheckout,
  pinFile,
  provenanceFile,
  readJson,
  sha256Hex,
  utf8,
  vectorsFile,
} from "./artefacts.ts";
import type { PinFile } from "./artefacts.ts";
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

/** The commit of a checkout of effx. A change to a tracked file would make vectors that no commit makes, so it fails. */
const cleanHead = Effect.fn("cleanHead")(function* cleanHead(effx: string) {
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

  if (changed !== "") {
    return yield* new ArtefactFailed({
      message: `EFFX_DIR (${head}) has local changes: it must be a clean checkout`,
    });
  }

  return head;
});

/**
 * What effx makes from the kernel's descriptions, on the pinned Alloy: its vectors and assertion results for each
 * domain, in the way that `generator` says. `effx` is a clean, installed checkout, at any commit. Nothing is written.
 */
const make = Effect.fn("make")(function* make(effx: string, pin: PinFile) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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

        yield* Effect.forEach(
          Rec.toEntries(generator.project),
          ([name, content]) =>
            fs.writeFileString(
              path.join(project, name),
              inCheckout(content, effx)
            ),
          { discard: true }
        );

        // effx analyses the project and resolves `effect` from it: the checkout's own dependencies are the project's.
        yield* Effect.forEach(
          Rec.toEntries(generator.links),
          ([name, target]) =>
            fs.symlink(inCheckout(target, effx), path.join(project, name)),
          { discard: true }
        );

        const outputs = yield* Effect.forEach(generator.commands, (argv) =>
          Effect.gen(function* command() {
            yield* Console.log(`${domain}: ${Arr.join(argv, " ")}`);

            const [program = "", ...args] = Arr.map(argv, (part) =>
              inCheckout(part, effx)
            );

            return yield* run(program, args, project);
          })
        );

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

        const assertions = assertionsOf(domain, Arr.join(outputs, "\n"));

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
                ({ calculated, name, states, transitions }) => ({
                  calculated: calculated.length,
                  commands: Arr.dedupe(
                    Arr.map(transitions, ({ command }) => command)
                  ).length,
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

  return {
    alloy: { executable, version: alloyVersion },
    derived,
    made,
    nixpkgs,
  };
});

export const regenerate = Effect.fn("regenerate")(function* regenerate() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pin = yield* readJson(Pin, pinFile);
  const effx = yield* Config.String("EFFX_DIR");
  const head = yield* cleanHead(effx);

  if (head !== pin.commit) {
    return yield* new ArtefactFailed({
      message: `EFFX_DIR must be a checkout of ${pin.repository} at ${pin.commit} (HEAD ${head})`,
    });
  }

  const { alloy, derived, made, nixpkgs } = yield* make(effx, pin);

  const provenance = yield* Schema.encodeEffect(
    Schema.fromJsonString(Provenance, { space: 2 })
  )({
    alloy,
    domains: Rec.fromEntries(
      Arr.map(made, ({ domain, provenance: found }) => [domain, found])
    ),
    effx: { commit: pin.commit, nixpkgs, repository: pin.repository },
    generator,
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

/**
 * Spec 0007d, gate G2: does effx, at the commit that `EFFX_DIR` holds (CI gives it effx's `main`), still make the
 * vectors that are committed? Nothing is written. It fails, naming the first line that differs in each domain, when the
 * vectors, the assertion results or any other fact of the provenance differ; the remedy is the pin and a regeneration.
 */
export const drift = Effect.fn("drift")(function* drift() {
  const pin = yield* readJson(Pin, pinFile);
  const committed = yield* readJson(Provenance, provenanceFile);
  const effx = yield* Config.String("EFFX_DIR");
  const head = yield* cleanHead(effx);
  const { made } = yield* make(effx, pin);

  const found = yield* differences(
    committed.domains,
    Rec.fromEntries(
      Arr.map(made, ({ domain, provenance }) => [domain, provenance])
    )
  );

  const where =
    head === pin.commit
      ? `effx at the pin ${pin.commit}`
      : `effx ${head}, which is past the pin ${pin.commit},`;

  if (Arr.isReadonlyArrayEmpty(found)) {
    return yield* Console.log(
      `${where} makes the committed vectors of ${Arr.join(Rec.keys(committed.domains), ", ")}`
    );
  }

  yield* Console.error(Arr.join(found, "\n"));

  return yield* new ArtefactFailed({
    message:
      head === pin.commit
        ? `${where} no longer makes the committed vectors (above): run description:regenerate and read the diff`
        : `${where} makes other vectors than the committed ones (above): to follow effx, set the commit of effx.pin.json to ${head}, run description:regenerate with EFFX_DIR at it, and commit the files`,
  });
}, Effect.scoped);
