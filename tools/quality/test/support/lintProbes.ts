import {
  Array as Arr,
  Effect,
  FileSystem,
  Record as Rec,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A scratch file: where it goes in the repository and what it holds. */
export interface Probe {
  readonly file: string;
  readonly content: string;
}

const Diagnostics = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        filename: Schema.String,
        labels: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              span: Schema.Struct({ line: Schema.optionalKey(Schema.Int) }),
            })
          )
        ),
      })
    ),
  })
);

const decodeDiagnostics = Schema.decodeUnknownEffect(Diagnostics);

/** One finding of `vp lint --format json`: the rule, the file and the lines it points at. */
export interface Diagnostic {
  readonly code: string;
  readonly filename: string;
  readonly lines: readonly number[];
}

/**
 * The real lint configuration, through `vp lint`, on the `probes` (written under `root` for the length of the call and
 * removed again, whatever happens) and on `targets` (paths that already exist). Vitest runs the tests of a file in
 * order, and the scans of the repository skip a probe by its name, so a probe is seen by the lint and by nothing else.
 */
export const lintProbes = Effect.fn("lintProbes")(function* lintProbes(
  root: string,
  probes: Readonly<Record<string, Probe>>,
  targets: readonly string[] = []
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.acquireUseRelease(
    Effect.forEach(
      Rec.values(probes),
      ({ content, file }) => fs.writeFileString(`${root}${file}`, content),
      { discard: true }
    ),
    () =>
      Effect.scoped(
        Effect.gen(function* lint() {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              "bunx",
              [
                "vp",
                "lint",
                "--format",
                "json",
                ...targets,
                ...Arr.map(Rec.values(probes), ({ file }) => file),
              ],
              { cwd: root, extendEnv: true, stdin: "ignore" }
            )
          );

          const stdout = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.mkString
          );

          const { diagnostics } = yield* decodeDiagnostics(stdout);

          return Arr.map(
            diagnostics,
            ({ code, filename, labels }): Diagnostic => ({
              code,
              filename,
              lines: Arr.flatMap(labels ?? [], (label) =>
                label.span.line === undefined ? [] : [label.span.line]
              ),
            })
          );
        })
      ),
    () =>
      Effect.forEach(
        Rec.values(probes),
        ({ file }) => fs.remove(`${root}${file}`, { force: true }),
        { discard: true }
      ).pipe(Effect.orDie)
  );
});
