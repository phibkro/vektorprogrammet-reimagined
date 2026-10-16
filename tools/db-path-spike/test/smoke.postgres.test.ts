/**
 * The smoke command's real client and checks, run against the in-process Worker on a local
 * PostgreSQL. Everything that is not the platform is exercised: request building, answer
 * decoding, every verdict, and the client abort of check 3b. Only check 1 may fail here:
 * a local Worker has no Hyperdrive binding, and the check says so.
 */
import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, Layer, Random } from "effect";

import { checks, runCheck } from "../src/smoke/checks.ts";
import { SpikeClient } from "../src/smoke/client.ts";
import { failedIds, renderLine, renderSummary } from "../src/smoke/report.ts";
import { localHttpClient, localWorker } from "./support/localWorker.ts";

const spikeClient = SpikeClient.layer("https://spike.test").pipe(
  Layer.provide(localHttpClient)
);

layer(localWorker(), { excludeTestServices: true })(
  "the smoke checks over the in-process Worker",
  (it) => {
    it.effect("every check passes except check 1, which needs Hyperdrive", () =>
      Effect.gen(function* smokeRun() {
        const id = `run-${yield* Random.nextIntBetween(10_000_000, 99_999_999)}`;
        const year = yield* Random.nextIntBetween(1000, 2_000_000_000);

        const lines = yield* Effect.forEach(checks({ id, year }), runCheck);

        assert.deepStrictEqual(
          failedIds(lines),
          ["1"],
          Arr.join(Arr.map(lines, renderLine), "\n")
        );

        const [first] = lines;

        assert.include(first?.verdict.evidence, "127.0.0.1");
        assert.strictEqual(lines.length, 12);
        assert.strictEqual(
          renderSummary(lines),
          "11 of 12 checks passed; failed: 1"
        );
        assert.isTrue(
          Arr.every(lines, (line) =>
            renderLine(line).startsWith(line.verdict.pass ? "PASS" : "FAIL")
          )
        );
      }).pipe(Effect.provide(spikeClient))
    );
  }
);
