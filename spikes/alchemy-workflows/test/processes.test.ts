import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { nodeServicesLayer } from "./support/nodeServices.ts";
import {
  awaitGone,
  descendantsOf,
  namespaceLine,
} from "./support/processes.ts";

/** A shell that starts a sleeping child and waits for it: two processes, one parent. */
const shellWithChild = ChildProcess.make("sh", ["-c", "sleep 600 & wait"]);

const kill = (pids: readonly number[]) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner
      .exitCode(ChildProcess.make("kill", ["-KILL", ...Arr.map(pids, String)]))
      .pipe(Effect.orDie)
  );

layer(nodeServicesLayer, { excludeTestServices: true })(
  "the custody of a runtime's processes",
  (it) => {
    it.effect("reads the descendants of a pid it owns, and nothing else", () =>
      Effect.gen(function* descendantsOfOwnedPid() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const parent = yield* spawner.spawn(shellWithChild);

        const below = yield* descendantsOf(parent.pid).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("50 millis"),
            until: (pids) => pids.length === 1,
          }),
          Effect.timeout("10 seconds")
        );

        assert.strictEqual(below.length, 1);
        assert.notStrictEqual(below[0], parent.pid);
        assert.deepStrictEqual(yield* descendantsOf(below[0] ?? 0), []);

        yield* kill([parent.pid, ...below]);
        yield* awaitGone([parent.pid, ...below]);
      })
    );

    it.effect(
      "awaitGone names an orphan: killing only the parent leaves the child alive and owned",
      () =>
        Effect.gen(function* orphanOutlivesItsParent() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const parent = yield* spawner.spawn(shellWithChild);

          const below = yield* descendantsOf(parent.pid).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (pids) => pids.length === 1,
            }),
            Effect.timeout("10 seconds")
          );

          const owned = [parent.pid, ...below];

          // The handle's own kill signals the whole process group, which would take the child with it. A runtime's
          // sidecar and workerd are not in the supervisor's group, so kill the leader alone, by pid.
          yield* kill([parent.pid]);
          yield* parent.isRunning.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (running) => !running,
            })
          );

          const refused = yield* Effect.flip(awaitGone(owned, "300 millis"));

          assert.strictEqual(refused._tag, "OrphanedProcesses");
          assert.deepStrictEqual(
            Arr.map(refused.survivors, (survivor) => survivor.pid),
            below
          );
          assert.isTrue(
            Arr.every(refused.survivors, (survivor) =>
              survivor.command.startsWith("sleep 600")
            )
          );

          yield* kill(below);
          yield* awaitGone(owned);
        })
    );

    it.effect("awaitGone passes for pids that no longer exist", () =>
      Effect.gen(function* nothingLeft() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const finished = yield* spawner.spawn(ChildProcess.make("true"));

        yield* finished.exitCode;
        yield* awaitGone([finished.pid], "5 seconds");
      })
    );

    it.effect(
      "a namespace dies with the process that launched it: a killed test runner leaves no runtime behind",
      () =>
        Effect.gen(function* namespaceDiesWithItsLauncher() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

          // A launcher that is not this test's own process: it starts the namespace, reports its pid, and waits.
          const launcher = yield* spawner.spawn(
            ChildProcess.make("sh", [
              "-c",
              `${Arr.join(namespaceLine("sleep", ["600"]), " ")} & echo $!; wait`,
            ])
          );

          const reported = yield* launcher.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("10 seconds")
          );

          const namespaced = Number(reported[0]);

          const below = yield* descendantsOf(namespaced).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (pids) => pids.length === 1,
            }),
            Effect.timeout("10 seconds")
          );

          assert.strictEqual(below.length, 1);

          // The launcher alone is killed: nothing signals the namespace, so only the parent-death signal can end it.
          // Without it the survivors are named by `OrphanedProcesses` after three seconds, inside the test's five.
          yield* kill([launcher.pid]);
          yield* awaitGone([namespaced, ...below], "3 seconds");
        })
    );
  }
);
