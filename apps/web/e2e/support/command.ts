/**
 * Runs one program of the harness to its end: the importer, `psql`, `emdash secrets generate`. Its standard error
 * goes to this process's own; its standard output comes back as text, so the caller reads what the program printed
 * (and chooses whether to show it: one of them prints a secret).
 */
import { Console, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The directories of the programs the harness runs. */
export const importerDirectory = new URL(
  "../../../../tools/import/",
  import.meta.url
).pathname;

export const cmsDirectory = new URL("../../../cms/", import.meta.url).pathname;

export const databaseDirectory = new URL(
  "../../../../packages/db/",
  import.meta.url
).pathname;

export class CommandFailed extends Schema.TaggedError<
  CommandFailed,
  { readonly brand: unique symbol }
>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Int,
}) {}

export const runToEnd = Effect.fn("runToEnd")(function* runToEnd(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly safeOutputOnFailure?: boolean;
  }
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* runChild() {
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: options.cwd,
          env: options.env ?? {},
          extendEnv: true,
          stderr: "inherit",
          stdin: "ignore",
        })
      );

      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" }
      );

      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        if (options.safeOutputOnFailure === true) {
          yield* Console.error(stdout);
        }

        return yield* new CommandFailed({ command, exitCode });
      }

      return stdout;
    })
  );
});
