import { NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { Mac } from "effect/crypto";

import { runtimePassword } from "../prepareSupport.ts";

it.effect("derives a stable branch-specific runtime password", () =>
  Effect.gen(function* testCase() {
    const seed = Redacted.make("synthetic-test-seed-0123456789abcdef");
    const repository = "phibkro/vektorprogrammet-reimagined";

    const first = yield* runtimePassword(
      seed,
      repository,
      "bbbbbbbbbbbbbbbbbbbb"
    );

    const repeated = yield* runtimePassword(
      seed,
      repository,
      "bbbbbbbbbbbbbbbbbbbb"
    );

    const other = yield* runtimePassword(
      seed,
      repository,
      "cccccccccccccccccccc"
    );

    assert.strictEqual(
      Redacted.value(first),
      "87bf28555d53e821244123f9003fd2cb78e34215b316e9f1716f53782fdcc089"
    );
    assert.strictEqual(Redacted.value(first), Redacted.value(repeated));
    assert.notStrictEqual(Redacted.value(first), Redacted.value(other));
  }).pipe(
    Effect.provide(
      Mac.layerWebCrypto.pipe(Layer.provide(NodeCrypto.layerSecureRandom))
    )
  )
);
