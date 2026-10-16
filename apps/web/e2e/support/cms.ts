/**
 * The CMS of the browser tests: EmDash on Astro (`apps/cms`, `astro dev`), set up the way a Preview is. It works in
 * the disposable database's schema `emdash`, which the role script that a deployment runs once creates here; it
 * starts with the default copy of `seed.json` (the development bypass applies the seed's content); and it then
 * takes the importer's fake articles, texts and sponsors, twice, the second run having to change nothing
 * (falsifier 4). Like `vp dev`, it is a child process owned by the scope that starts it: closing the scope stops
 * its whole process group.
 */
import {
  Array as Arr,
  Console,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CommandFailed,
  cmsDirectory,
  importerDirectory,
  runToEnd,
} from "./command.ts";

export interface Cms {
  readonly origin: string;
  /** A personal access token with every scope, as the development bypass mints it. */
  readonly token: Redacted.Redacted;
}

/** The role and the schema of `apps/cms/db/emdash-role.sql`. */
const EMDASH_ROLE = "emdash_app";

/** Miniflare's local Hyperdrive wants a password in the URL; trust authentication ignores it. */
const hyperdriveUrl = (databaseUrl: Redacted.Redacted): string => {
  const url = new URL(Redacted.value(databaseUrl));
  url.username = EMDASH_ROLE;
  url.password = "local";

  return url.toString();
};

const DevBypassAnswer = Schema.Struct({
  data: Schema.Struct({ token: Schema.String }),
});

/** `emdash secrets generate` prints a banner and then the key on its last line. */
const lastLine = (text: string): string =>
  Option.match(
    Arr.last(Arr.filter(text.split("\n"), (line) => line.trim() !== "")),
    { onNone: () => "", onSome: (line) => line.trim() }
  );

/**
 * Starts the CMS on `port` over `databaseUrl` and signs a development administrator in with the bypass that
 * `astro dev` alone offers, which also applies the seed's default copy and returns a token for the importer.
 */
export const startCms = Effect.fn("startCms")(function* startCms(options: {
  readonly databaseUrl: Redacted.Redacted;
  readonly port: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const origin = `http://localhost:${options.port}`;

  yield* runToEnd(
    "psql",
    [
      Redacted.value(options.databaseUrl),
      "--set=ON_ERROR_STOP=1",
      `--file=${cmsDirectory}db/emdash-role.sql`,
    ],
    { cwd: cmsDirectory }
  );

  const encryptionKey = lastLine(
    yield* runToEnd("bunx", ["emdash", "secrets", "generate"], {
      cwd: cmsDirectory,
    })
  );

  const cms = yield* spawner.spawn(
    ChildProcess.make(
      "bunx",
      ["astro", "dev", "--port", String(options.port), "--ignore-lock"],
      {
        cwd: cmsDirectory,
        env: {
          CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
            hyperdriveUrl(options.databaseUrl),
          CMS_STANDALONE: "1",
          EMDASH_ENCRYPTION_KEY: encryptionKey,
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

  // The first request runs EmDash's migrations and creates the collections of the seed: it answers late.
  const answering = http
    .execute(HttpClientRequest.get(`${origin}/_emdash/api/setup/status`))
    .pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 300 }));

  const exitedEarly = Effect.flatMap(
    cms.exitCode,
    (exitCode) => new CommandFailed({ command: "astro dev", exitCode })
  );

  yield* Effect.raceFirst(answering, exitedEarly);

  const token = yield* HttpClientRequest.post(
    `${origin}/_emdash/api/setup/dev-bypass?token=1`
  ).pipe(
    http.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DevBypassAnswer)),
    Effect.map(({ data }) => Redacted.make(data.token))
  );

  return { origin, token } satisfies Cms;
}, Effect.provide(FetchHttpClient.layer));

/**
 * Runs the importer's `import:fixture:cms` script against `cms`, and returns what it printed: one line saying, per
 * collection, how many entries it created and how many were already there.
 */
const importFixtureInto = (cms: Cms) =>
  runToEnd("bun", ["run", "import:fixture:cms"], {
    cwd: importerDirectory,
    env: {
      IMPORT_CMS_TOKEN: Redacted.value(cms.token),
      IMPORT_CMS_URL: cms.origin,
    },
  });

/** A line of the importer's summary that names a collection it created entries in. */
const CREATED_SOMETHING = /\b[1-9]\d* created\b/u;

/**
 * Falsifier 4 on the real CMS: the first run puts the fixture's articles, texts and sponsors in; the second finds
 * every one of them there and creates nothing.
 */
export const importFixtureTwice = Effect.fn("importFixtureTwice")(
  function* importFixtureTwice(cms: Cms) {
    const first = yield* importFixtureInto(cms);
    yield* Console.log(first.trim());

    if (!CREATED_SOMETHING.test(first)) {
      return yield* Effect.die(
        "the first fixture import created nothing in the CMS"
      );
    }

    const second = yield* importFixtureInto(cms);
    yield* Console.log(second.trim());

    if (CREATED_SOMETHING.test(second)) {
      return yield* Effect.die(
        "the second fixture import created entries: the import is not idempotent"
      );
    }

    return yield* Effect.void;
  }
);
