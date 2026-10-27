/**
 * The Cloudflare CLI, `cf`, as the typed client of the Workflows API for the deployed run. The package is the one that
 * `tools/db-path-spike` pins (`cf` 1.0.0-beta.12): this spike installs no second copy and no raw HTTP client. `cf` is
 * authenticated outside this process, by the operator's own login, so nothing here reads, prints or passes a token.
 * Its output is JSON, decoded at this edge. A failure carries the first words of the command and a stderr stripped of
 * ids, never a payload.
 */
import { Array as Arr, Effect, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CfFailed, UnreadableApiBody } from "./errors.ts";

const CF = new URL(
  "../../../../tools/db-path-spike/node_modules/.bin/cf",
  import.meta.url
).pathname;

/** Account and object ids are 32 hexadecimal digits: they stay out of an error. */
const withoutIds = (text: string) => text.replaceAll(/[0-9a-f]{32}/gu, "<id>");

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown)
);

const textOf = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) => Stream.mkString(Stream.decodeText(stream));

/** What one `cf` call printed: its stdout, and the parsed JSON of it. The raw text is kept for the evidence file. */
export interface CfOutput {
  readonly json: unknown;
  readonly raw: string;
}

/**
 * Runs `cf` with `args` (never a secret: the parameters of an instance are ids and an instant) and decodes its JSON.
 * `DO_NOT_TRACK=1` is the repository's rule for `cf`.
 */
export const cf = Effect.fn("cf")(function* cf(args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const label = Arr.join(Arr.take(args, 4), " ");

  const raw = yield* Effect.scoped(
    Effect.gen(function* run() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(CF, args, {
          env: { DO_NOT_TRACK: "1" },
          extendEnv: true,
          stdin: "ignore",
        })
      );

      const [stdout, stderr, code] = yield* Effect.all(
        [textOf(handle.stdout), textOf(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" }
      );

      if (code !== 0) {
        return yield* new CfFailed({
          args: label,
          code,
          stderr: withoutIds(stderr).slice(0, 600),
        });
      }

      return stdout;
    })
  );

  const json = yield* decodeJson(raw).pipe(
    Effect.mapError(
      (error) =>
        new UnreadableApiBody({
          args: label,
          reason: error.message.slice(0, 200),
        })
    )
  );

  return { json, raw } satisfies CfOutput;
});
