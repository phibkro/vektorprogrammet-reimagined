/**
 * `vp dev` for the browser tests: the `local` deployment (a test actor chosen by cookie, a simulated R2 and
 * rate limiter, no mail), pointed at the disposable database and at the CMS (`cms.ts`), with Cloudflare's
 * always-pass Turnstile keys, and with the cron's `scheduled` handler run once (the semester job). The dev
 * server is a child process owned by the scope that starts it: closing the scope stops its whole process group
 * (`vp`, Vite and workerd).
 */
import { Effect, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { TURNSTILE_TEST_KEYS } from "../../worker.config.ts";
import type { Cms } from "./cms.ts";

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
  "/kontrollpanel/arrangementer",
  "/kontrollpanel/team",
  "/kontrollpanel/team/1",
  "/kontrollpanel/personer",
  "/kontrollpanel/administratorer",
  "/",
  "/om-oss",
  "/assistenter",
  "/team",
  "/foreldre",
  "/skoler",
  "/nyheter",
  "/nyhet/opptak-apner",
  "/kontakt",
];

/** The Cloudflare Vite plugin forwards this path to the Worker's `scheduled` handler (the cron, once). */
const SCHEDULED_HANDLER_PATH = "/cdn-cgi/handler/scheduled";

/** Vite binds `localhost`, which is `::1` on some hosts: the probe and the browser both use the name. */
const originOf = (port: number): string => `http://localhost:${port}`;

export const startDevServer = Effect.fn("startDevServer")(
  function* startDevServer(options: {
    readonly webDirectory: string;
    readonly port: number;
    readonly databaseUrl: Redacted.Redacted;
    readonly cms: Cms;
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
            CMS_TOKEN: Redacted.value(options.cms.token),
            CMS_URL: options.cms.origin,
            DATABASE_URL: Redacted.value(options.databaseUrl),
            SITE_URL: origin,
            TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretKey,
            TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKey,
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

    // Semesters are written by the cron job only (spec 0003): run the Worker's `scheduled` handler once, as
    // the Cloudflare Vite plugin exposes it, so the current and the next semester exist before any page asks.
    const answering = get("/").pipe(
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 240 }),
      Effect.andThen(get(SCHEDULED_HANDLER_PATH)),
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
