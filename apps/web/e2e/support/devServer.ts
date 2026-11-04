/** Start one locally configured Worker and own its child process until scope exit. */
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class DevServerFailed extends Schema.TaggedError<
  DevServerFailed,
  { readonly brand: unique symbol }
>()("DevServerFailed", {
  message: Schema.String,
}) {}

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
          env: {
            DATABASE_URL: Redacted.value(options.databaseUrl),
            SITE_URL: origin,
          },
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
      Effect.andThen(get("/cdn-cgi/handler/scheduled"))
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
