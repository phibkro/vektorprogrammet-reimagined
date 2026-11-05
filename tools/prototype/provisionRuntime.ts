import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Crypto, Effect, FileSystem, Path, Redacted } from "effect";

import {
  probeRuntimeLogin,
  provisionRuntimeAccess,
  runtimeRoleExists,
} from "../../apps/web/src/adapters/db/runtimeAccess.ts";
import { runtimeDatabaseUrl } from "../../apps/web/src/adapters/db/runtimeUrl.ts";

const outsideWorktree = (path: Path.Path, root: string, location: string) => {
  const relative = path.relative(root, location);

  return (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
};

const program = Effect.gen(function* provisionRuntimeMain() {
  const admin = yield* Config.Redacted("MIGRATION_DATABASE_URL");
  const file = yield* Config.String("RUNTIME_DATABASE_URL_FILE");
  const owned = yield* Config.String("SYNTHETIC_SUPABASE_OWNED");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  if (owned !== "1" || !path.isAbsolute(file)) {
    return yield* Effect.die(
      "An owned synthetic target and absolute runtime credential path are required"
    );
  }

  const root = yield* fs.realPath(process.cwd());
  const parent = yield* fs.realPath(path.dirname(file));
  const location = path.resolve(parent, path.basename(file));

  if (!outsideWorktree(path, root, location)) {
    return yield* Effect.die(
      "Runtime credentials must be outside the worktree"
    );
  }

  if (!URL.canParse(Redacted.value(admin))) {
    return yield* Effect.die("MIGRATION_DATABASE_URL is malformed");
  }

  const target = new URL(Redacted.value(admin));

  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    return yield* Effect.die(
      "Provisioning requires a direct local database URL"
    );
  }

  let runtime: string;

  if (yield* fs.exists(file)) {
    const info = yield* fs.lstat(file);

    if (info.type !== "File" || info.mode % 64 !== 0) {
      return yield* Effect.die("Runtime credential file must be private");
    }

    runtime = (yield* fs.readFileString(file)).trim();
  } else {
    target.username = "vektor_runtime";
    target.password =
      (yield* crypto.randomUUIDv4()).replaceAll("-", "") +
      (yield* crypto.randomUUIDv4()).replaceAll("-", "");
    runtime = target.toString();
    yield* fs.writeFileString(file, `${runtime}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }

  if (!URL.canParse(runtime)) {
    return yield* Effect.die(
      "RUNTIME_DATABASE_URL_FILE contains a malformed URL"
    );
  }

  const parsed = new URL(runtime);
  const adminTarget = new URL(Redacted.value(admin));

  if (
    parsed.username !== "vektor_runtime" ||
    parsed.hostname !== adminTarget.hostname ||
    parsed.port !== adminTarget.port ||
    parsed.pathname !== adminTarget.pathname ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^[a-f0-9]{64}$/u.test(parsed.password)
  ) {
    return yield* Effect.die("Runtime credential does not match target");
  }

  const existing = yield* runtimeRoleExists(admin);
  const login = probeRuntimeLogin(runtimeDatabaseUrl(runtime));

  if (existing) {
    yield* login;
  }

  yield* provisionRuntimeAccess(admin, parsed.password);
  yield* login;

  return yield* Effect.void;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch(() =>
      Effect.die(
        "Runtime provisioning failed; check bootstrap authority and the private credential file. Existing credentials are never rotated."
      )
    ),
    Effect.orDie
  )
);
