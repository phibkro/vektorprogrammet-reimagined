/**
 * Custody of a runtime's processes: a PID namespace, and reads of owned pids only.
 *
 * `alchemy dev` is a tree: the supervisor, its exec child, a sidecar that leads a process group of its own, and the
 * workerd that the sidecar starts. A test that kills "the runtime" must kill all of it and prove that nothing is left.
 * The runtime therefore starts as the first process of a PID namespace of its own (`unshare --pid --fork
 * --kill-child`): the kernel kills every process of a namespace when its first process dies, and a process cannot
 * leave it, so one SIGKILL of the `unshare` process ends the whole tree and nothing can outlive it.
 *
 * A killed test runner must leave nothing behind either, and a finalizer cannot run in a killed process (stopping a
 * test job once left a runtime listening on its port). `unshare` therefore starts under `setpriv --pdeathsig SIGKILL`:
 * when its parent dies, the kernel kills it, and `--kill-child` takes the namespace with it.
 *
 * Nothing here looks at a process the runtime does not own. The tree is read from the kernel's child lists of the
 * pids it already owns (`/proc/<pid>/task/<tid>/children`), and a pid is checked by whether `/proc/<pid>` exists. No
 * other process's environment, command line or files are read.
 */
import { Array as Arr, Effect, FileSystem, Schedule } from "effect";
import type { Duration } from "effect";
import { ChildProcess } from "effect/process";

import { OrphanedProcesses } from "./errors.ts";

/** What precedes the command: the parent-death signal for `unshare`, and the namespace flags. */
const LAUNCHER = [
  "--pdeathsig",
  "SIGKILL",
  "--",
  "unshare",
  "--user",
  "--map-root-user",
  "--pid",
  "--fork",
  "--kill-child",
  "--mount-proc",
  "--",
] as const;

/** The command line, as words for a shell, of `command` run as the first process of a PID namespace. */
export const namespaceLine = (command: string, args: readonly string[]) => [
  "setpriv",
  ...LAUNCHER,
  command,
  ...args,
];

/** `command` run as the first process of a PID namespace that dies with its launcher, and its launcher with its parent. */
export const inPidNamespace = (
  command: string,
  args: readonly string[],
  options: ChildProcess.CommandOptions
) => ChildProcess.make("setpriv", [...LAUNCHER, command, ...args], options);

const childrenOf = Effect.fnUntraced(function* childrenOf(pid: number) {
  const fs = yield* FileSystem.FileSystem;

  const threads = yield* fs
    .readDirectory(`/proc/${pid}/task`)
    // A process that has exited has no threads: it has no children either.
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<readonly string[]>([])
      )
    );

  const lists = yield* Effect.forEach(threads, (thread) =>
    fs
      .readFileString(`/proc/${pid}/task/${thread}/children`)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed("")
        )
      )
  );

  return Arr.flatMap(lists, (list) =>
    Arr.map(
      Arr.filter(list.split(" "), (item) => item !== ""),
      Number
    )
  );
});

/** The pids below `root`, root excluded, from the child lists of pids already owned. */
export const descendantsOf = Effect.fn("processes.descendantsOf")(
  function* descendantsOf(root: number) {
    const found: number[] = [];
    let frontier = [root];

    while (frontier.length > 0) {
      const next = yield* Effect.forEach(frontier, childrenOf);

      frontier = Arr.flatten(next);
      found.push(...frontier);
    }

    return found;
  }
);

const commandOf = Effect.fnUntraced(function* commandOf(pid: number) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(`/proc/${pid}/cmdline`).pipe(
    Effect.map((text) => Arr.join(text.split("\u0000"), " ").trim()),
    Effect.catchTag("PlatformError", () => Effect.succeed(""))
  );
});

const alive = Effect.fnUntraced(function* alive(pids: readonly number[]) {
  const fs = yield* FileSystem.FileSystem;

  const exist = yield* Effect.forEach(pids, (pid) =>
    fs.exists(`/proc/${pid}`).pipe(Effect.orDie)
  );

  return Arr.filter(pids, (_, index) => exist[index] === true);
});

/**
 * Polls until none of `pids` exists, and fails with `OrphanedProcesses` naming the survivors when one still does
 * after `timeout`. This is the "no orphans" assertion, over the pids a runtime owned.
 */
export const awaitGone = Effect.fn("processes.awaitGone")(function* awaitGone(
  pids: readonly number[],
  timeout: Duration.Input = "10 seconds"
) {
  const survivors = yield* alive(pids).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (remaining) => remaining.length === 0,
    }),
    Effect.timeoutOption(timeout),
    Effect.flatMap(() => alive(pids))
  );

  if (survivors.length > 0) {
    return yield* new OrphanedProcesses({
      survivors: yield* Effect.forEach(survivors, (pid) =>
        Effect.map(commandOf(pid), (command) => ({ command, pid }))
      ),
    });
  }

  return yield* Effect.void;
});
