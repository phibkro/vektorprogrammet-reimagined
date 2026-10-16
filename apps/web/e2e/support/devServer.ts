/**
 * `vp dev` for the browser tests: the `local` deployment (a test actor chosen by cookie, a simulated R2 and
 * rate limiter, no mail), pointed at the disposable database. The dev server is a child process owned by the
 * scope that starts it: closing the scope stops its whole process group (`vp`, Vite and workerd).
 */
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class DevServerFailed extends Schema.TaggedError<
  DevServerFailed,
  { readonly brand: unique symbol }
>()("DevServerFailed", {
  message: Schema.String,
}) {}

/** Pages the tests open: fetched once so the server compiles them before the first browser asks. */
const WARM_UP_PATHS = [
  "/kontrollpanel",
  "/kontrollpanel/avdelinger",
  "/kontrollpanel/semestre",
  "/kontrollpanel/linjer",
];

/** Vite binds `localhost`, which is `::1` on some hosts: the probe and the browser both use the name. */
const originOf = (port: number): string => `http://localhost:${port}`;

export const startDevServer = Effect.fn("startDevServer")(
  function* startDevServer(options: {
    readonly webDirectory: string;
    readonly port: number;
    readonly databaseUrl: Redacted.Redacted;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const origin = originOf(options.port);

    const dev = yield* spawner.spawn(
      ChildProcess.make(
        "bunx",
        ["vp", "dev", "--port", String(options.port), "--strictPort"],
        {
          cwd: options.webDirectory,
          env: { DATABASE_URL: Redacted.value(options.databaseUrl) },
          extendEnv: true,
          forceKillAfter: "10 seconds",
          killSignal: "SIGTERM",
          stderr: "inherit",
          stdin: "ignore",
          stdout: "inherit",
        }
      )
    );

    const get = (path: string) =>
      http.execute(HttpClientRequest.get(`${origin}${path}`));

    const answering = get("/").pipe(
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 240 }),
      Effect.andThen(Effect.forEach(WARM_UP_PATHS, get, { discard: true }))
    );

    const exitedEarly = Effect.flatMap(
      dev.exitCode,
      (exitCode) =>
        new DevServerFailed({
          message: `vp dev exited with code ${exitCode} before it answered on ${origin}`,
        })
    );

    yield* Effect.raceFirst(answering, exitedEarly);

    return origin;
  },
  Effect.provide(FetchHttpClient.layer)
);
