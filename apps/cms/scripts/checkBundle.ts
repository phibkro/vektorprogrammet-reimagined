import { builtinModules } from "node:module";

/**
 * `bun run check:cms`: the CMS Worker as it is deployed, run in workerd, before it is deployed.
 *
 * `Cloudflare.Website.Astro("Cms")` (`apps/web/alchemy.run.ts`) builds the project with `buildInChild` and the
 * Worker's compatibility date and flags, then uploads the server modules. This script does the same build, then:
 *
 * 1. looks for a `require()` of a Node built-in that survived as rolldown's throwing `__require` shim (the module
 *    imports it from the runtime chunk). It throws in an ES module Worker, and the first deploy of the CMS answered
 *    500 to every request because of it (`build/ownExternalRequire.ts` says why and what fixes it). This finds those
 *    in code no request below reaches.
 * 2. runs the modules in workerd (Miniflare, the version `@cloudflare/vite-plugin` runs) with `nodejs_compat`, the
 *    bindings the Worker has (Hyperdrive on a disposable PostgreSQL database that `db/emdash-role.sql` set up, a KV
 *    namespace for the session, an R2 bucket, the encryption key) and asks EmDash for its setup status. The first
 *    request loads `pg`, runs EmDash's migrations and applies the seed, so it fails on anything that works under
 *    `astro dev` and breaks in the deployed bundle.
 *
 * It needs the devenv PostgreSQL (`TEST_DATABASE_ADMIN_URL`) and runs from `apps/cms` (`bun run check:cms` from the
 * root does that): Astro's build wants its working directory to be the project root.
 */
import { buildInChild } from "@alchemy.run/frontend-frameworks/astro/source";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  Array as Arr,
  Console,
  Context,
  Effect,
  Layer,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import {
  CMS_COMPATIBILITY_FLAGS,
  COMPATIBILITY_DATE,
} from "../../web/worker.config.ts";

const root = new URL("..", import.meta.url).pathname;

/**
 * The flags the deployed Worker has: its own, and the module registry Alchemy adds to every Worker
 * (`withDefaultFlags` in `@alchemy.run/cloudflare-runtime`).
 */
const COMPATIBILITY_FLAGS = [...CMS_COMPATIBILITY_FLAGS, "new_module_registry"];

/** A key in EmDash's format (`emdash secrets generate`): this Worker never stores a secret, it only reads the key. */
const ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;

/** What `/_emdash/api/setup/status` answers on a database where nobody has finished the setup. */
const SetupStatus = Schema.Struct({
  data: Schema.Struct({ needsSetup: Schema.Boolean }),
  success: Schema.Literal(true),
});

class BundleCheckFailed extends Schema.TaggedError<
  BundleCheckFailed,
  { readonly brand: unique symbol }
>()("BundleCheckFailed", {
  message: Schema.String,
}) {}

const decode = (content: string | Uint8Array): string =>
  Predicate.isString(content) ? content : new TextDecoder().decode(content);

/** The module declares `__require` itself (EmDash's registry verification does, with `createRequire`). */
const DECLARES_REQUIRE = /\b(?:var|let|const)\s+__require\b/u;

const REQUIRE_OF = /__require\("(?<id>[^"]+)"\)/gu;

const NODE_BUILTINS = new Set(
  Arr.flatMap(builtinModules, (id) => [id, `node:${id}`])
);

/** `server/chunks/dialect_x.mjs: events, util` for each module that requires built-ins through rolldown's shim. */
const throwingRequires = (
  modules: readonly { name: string; content: string | Uint8Array }[]
) =>
  Arr.filterMap(modules, ({ name, content }) => {
    const text = decode(content);

    if (DECLARES_REQUIRE.test(text)) {
      return Result.failVoid;
    }

    const ids = Arr.dedupe(
      Arr.filter(
        Arr.map(
          [...text.matchAll(REQUIRE_OF)],
          (match) => match.groups?.id ?? ""
        ),
        (id) => NODE_BUILTINS.has(id)
      )
    );

    return Arr.isReadonlyArrayNonEmpty(ids)
      ? Result.succeed(`${name}: ${Arr.join(ids, ", ")}`)
      : Result.failVoid;
  });

const REQUIRE_ADVICE =
  "A CommonJS dependency that the bundle inlines still requires a Node built-in through rolldown's throwing " +
  "`__require`: it throws in workerd. `apps/cms/build/ownExternalRequire.ts` converts those requires to imports; " +
  "check that its `vite` is the copy that `astro` builds with (`bun why vite`).";

const checkBundle = Effect.gen(function* checkBundleProgram() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;

  // The database the Worker's Hyperdrive points at: the same schemas as Neon, the same role script.
  const database = yield* Layer.build(migratedTestDatabase);

  const databaseUrl = new URL(
    Redacted.value(Context.get(database, TestDatabaseUrl))
  );

  const roleScript = new URL("../db/emdash-role.sql", import.meta.url).pathname;

  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "psql",
      [
        databaseUrl.href,
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        `--file=${roleScript}`,
      ],
      {
        // The role script is idempotent: a role left by an earlier run would print a NOTICE for each grant.
        env: { PGOPTIONS: "--client-min-messages=warning" },
        extendEnv: true,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "ignore",
      }
    )
  );

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new BundleCheckFailed({
      message: `psql could not run db/emdash-role.sql (exit code ${exitCode})`,
    });
  }

  // As the deploy builds it: the compatibility settings the Worker declares, and Alchemy's `output: "server"`.
  const output = yield* buildInChild({
    astro: { output: "server" },
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
    config: undefined,
    env: {},
    prerenderEnvironment: undefined,
    rootDir: root,
    sessionDevKV: undefined,
    sessionKVBindingName: undefined,
    sessions: undefined,
  });

  const modules = output.serverModules ?? [];
  yield* Console.log(
    `built ${modules.length} server modules, entry ${modules[0]?.name}`
  );

  const unsafe = throwingRequires(modules);

  if (Arr.isReadonlyArrayNonEmpty(unsafe)) {
    return yield* new BundleCheckFailed({
      message: `${REQUIRE_ADVICE}\n${Arr.join(unsafe, "\n")}`,
    });
  }

  // Hyperdrive's local string: Miniflare wants a password in it, and trust authentication ignores it.
  const hyperdrive = new URL(databaseUrl.href);
  hyperdrive.username = "emdash_app";
  hyperdrive.password = "local";

  const miniflare = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare(
          convertV4MiniflareOptions({
            workers: [
              {
                bindings: { EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY },
                compatibilityDate: COMPATIBILITY_DATE,
                compatibilityFlags: COMPATIBILITY_FLAGS,
                hyperdrives: { HYPERDRIVE: hyperdrive.href },
                kvNamespaces: ["SESSION"],
                modules: Arr.map(modules, ({ name, content }) => ({
                  contents: content,
                  path: `/cms/${name}`,
                  type: "ESModule" as const,
                })),
                modulesRoot: "/cms",
                name: "cms",
                r2Buckets: ["MEDIA"],
              },
            ],
          })
        )
    ),
    (running) => Effect.promise(() => running.dispose())
  );

  const origin = yield* Effect.promise(() => miniflare.ready);
  const path = "/_emdash/api/setup/status";
  const response = yield* http.get(new URL(path, origin).href);

  if (response.status !== 200) {
    return yield* new BundleCheckFailed({
      message: `GET ${path} answered ${response.status}, not 200. workerd's log above says why. ${REQUIRE_ADVICE}`,
    });
  }

  const status =
    yield* HttpClientResponse.schemaBodyJson(SetupStatus)(response);

  if (!status.data.needsSetup) {
    return yield* new BundleCheckFailed({
      message:
        "a database nobody has set up reported that its setup is finished",
    });
  }

  yield* Console.log(
    `the CMS bundle answers in workerd: GET ${path} -> 200, EmDash migrated its schema in PostgreSQL and awaits its setup`
  );

  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.timeout("2 minutes"),
  Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
);

NodeRuntime.runMain(checkBundle);
