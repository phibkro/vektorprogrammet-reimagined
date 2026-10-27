/**
 * A runtime under test: `alchemy dev` for the spike's stack, owned and killed by the harness.
 *
 * The runtime starts as the first process of a PID namespace (`processes.ts`) in a directory of the test's own, so
 * its local state and the engine's files live under `<directory>/.alchemy`, a path the test names and removes. Its
 * output goes to `<directory>/dev-<label>.log`, which is the evidence log. The Worker's URL is read from the line
 * that `alchemy dev` prints when workerd serves it. `crash` is the falsifier's SIGKILL: one signal to the namespace's
 * first process, then proof that every process it owned is gone and that the Worker no longer answers.
 */
import {
  Array as Arr,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { EventsReportSchema, StatusReportSchema } from "../../src/renewal.ts";
import type { RenewalInputEncoded } from "../../src/renewal.ts";
import { RuntimeNotReady, UnexpectedResponse } from "./errors.ts";
import { awaitGone, descendantsOf, inPidNamespace } from "./processes.ts";

const ALCHEMY_CLI = new URL(
  "../../node_modules/alchemy/bin/cli.js",
  import.meta.url
).pathname;

const STACK = new URL("../../alchemy.run.ts", import.meta.url).pathname;

/** The line `alchemy dev` prints when workerd serves the Worker: `[RenewalWorker] Started in 7026ms → http://…/`. */
const STARTED = /Started in \d+ms → (?<url>http:\/\/localhost:\d+)/u;

export interface Runtime {
  readonly directory: string;
  readonly label: string;
  readonly logFile: string;
  /** The host pids the runtime owned when it was last read: the namespace's first process and everything below it. */
  readonly owned: readonly number[];
  /** The pid of the `unshare` process, the one that a crash signals. */
  readonly pid: number;
  readonly url: string;
}

export interface RuntimeOptions {
  readonly databaseUrl: string;
  readonly directory: string;
  readonly label: string;
}

/**
 * Starts `alchemy dev` for the spike's stack and waits until the Worker answers `/health`. The runtime lives as long
 * as the surrounding scope: closing it signals the process group, the `unshare` process dies, and the kernel ends the
 * namespace.
 */
export const startRuntime = Effect.fn("runtime.start")(function* startRuntime(
  options: RuntimeOptions
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;

  yield* fs
    .makeDirectory(options.directory, { recursive: true })
    .pipe(Effect.orDie);

  const logFile = path.join(options.directory, `dev-${options.label}.log`);

  // A runtime start bundles the Worker and compiles it in workerd: a burst that uses every core for ten seconds or
  // more. It runs niced, so that the rest of the machine keeps its cycles; nothing in the tests depends on its speed.
  const handle = yield* spawner
    .spawn(
      inPidNamespace(
        "nice",
        ["-n", "15", "bun", ALCHEMY_CLI, "dev", "--stage", "spike", STACK],
        {
          cwd: options.directory,
          env: { DATABASE_URL: options.databaseUrl },
          extendEnv: true,
          // Closing the scope signals the group and waits for the leader; a runtime that does not stop is killed, and
          // the namespace goes with it.
          forceKillAfter: "15 seconds",
          stdin: "ignore",
        }
      )
    )
    .pipe(Effect.orDie);

  const started = yield* Deferred.make<string>();

  yield* handle.all.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* record() {
        yield* fs.writeFileString(logFile, `${line}\n`, { flag: "a" });

        const url = STARTED.exec(line)?.groups?.url;

        if (url !== undefined) {
          yield* Deferred.succeed(started, url);
        }
      })
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  const exited = handle.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.fail(
        new RuntimeNotReady({
          reason: `alchemy dev exited with code ${code} before the Worker started; see ${logFile}`,
        })
      )
    ),
    Effect.orDie
  );

  const url = yield* Effect.raceFirst(Deferred.await(started), exited).pipe(
    Effect.timeoutOrElse({
      duration: "120 seconds",
      orElse: () =>
        Effect.fail(
          new RuntimeNotReady({
            reason: `the Worker did not start within 120 seconds; see ${logFile}`,
          })
        ),
    })
  );

  yield* http.get(`${url}/health`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(
            new UnexpectedResponse({ path: "/health", status: response.status })
          )
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    Effect.mapError(
      () =>
        new RuntimeNotReady({
          reason: `the Worker at ${url} never answered /health; see ${logFile}`,
        })
    )
  );

  const below = yield* descendantsOf(handle.pid);

  return {
    directory: options.directory,
    label: options.label,
    logFile,
    owned: [handle.pid, ...below],
    pid: handle.pid,
    url,
  } satisfies Runtime;
});

/**
 * Crashes a runtime: SIGKILL to the `unshare` process alone, not to its group, so that only the namespace can have
 * ended the rest. Then proof: no pid the runtime owned exists any more, and the Worker no longer answers. Returns the
 * pids that were owned, for the report.
 */
export const crash = Effect.fn("runtime.crash")(function* crash(
  runtime: Runtime
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;

  const owned = Arr.dedupe([
    ...runtime.owned,
    ...(yield* descendantsOf(runtime.pid)),
  ]);

  yield* spawner
    .exitCode(ChildProcess.make("kill", ["-KILL", String(runtime.pid)]))
    .pipe(Effect.orDie);

  yield* awaitGone(owned);

  // The port is closed: the request must fail to connect. A response would mean a survivor serves it.
  yield* Effect.flip(
    http.get(`${runtime.url}/health`).pipe(Effect.timeout("3 seconds"))
  );

  return owned;
});

/** The Worker's routes, decoded. A status other than the one expected is a typed failure. */
export const api = (runtime: Runtime) => {
  const call = Effect.fn("runtime.api.call")(function* call(
    request: HttpClientRequest.HttpClientRequest,
    path: string
  ) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(request);

    return { body: yield* response.json, path, status: response.status };
  });

  return {
    create: (input: RenewalInputEncoded) =>
      call(
        HttpClientRequest.post(`${runtime.url}/renewals`).pipe(
          HttpClientRequest.bodyJsonUnsafe(input)
        ),
        "/renewals"
      ),
    events: (id: string) =>
      call(
        HttpClientRequest.get(`${runtime.url}/renewals/${id}/events`),
        `/renewals/${id}/events`
      ).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(EventsReportSchema)(result.body)
        )
      ),
    status: (id: string) =>
      call(
        HttpClientRequest.get(`${runtime.url}/renewals/${id}`),
        `/renewals/${id}`
      ).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(StatusReportSchema)(result.body)
        )
      ),
    stop: (id: string, stoppedBy: number) =>
      call(
        HttpClientRequest.post(`${runtime.url}/renewals/${id}/stop`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ stoppedBy })
        ),
        `/renewals/${id}/stop`
      ),
  };
};
