/**
 * Checks 9 and 10 need no database: the sanitizer and the bcrypt verifier run in the Worker
 * as pure code. Here they run in Node through the Worker's real routes, so the fixtures the
 * deployed run compares against are proven to hold where they were made.
 */
import { assert, describe, it } from "@effect/vitest";
import { compareSync } from "bcryptjs";
import { Array as Arr, Effect, Schema } from "effect";

import { allowedRichText, bcryptProbe, xssCorpus } from "../src/fixtures.ts";
import * as Protocol from "../src/protocol.ts";
import { sanitizeVerdict } from "../src/verdicts.ts";
import worker from "../src/worker.ts";

/** A Worker environment whose database address is never opened: these routes do not touch it. */
const unused = {
  HYPERDRIVE: { connectionString: "postgres://unused@127.0.0.1:1/none" },
};

const noWork = { waitUntil: () => {} };

const call = <A>(
  schema: Schema.Codec<A>,
  method: "GET" | "POST",
  path: string,
  params: Readonly<Record<string, string>> = {}
) =>
  Effect.promise(
    async () =>
      await worker.fetch(
        new Request(
          `https://spike.test${path}?${new URLSearchParams(params)}`,
          {
            method,
          }
        ),
        unused,
        noWork
      )
  ).pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => await response.text())
    ),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema)))
  );

describe("check 9 fixtures", () => {
  it.effect(
    "the Worker's sanitizer gives the corpus' expected outputs and keeps the allowed tags",
    () =>
      Effect.gen(function* sanitized() {
        const answer = yield* call(
          Protocol.Sanitize,
          "GET",
          Protocol.routes.sanitize
        );

        assert.deepStrictEqual(
          answer.outputs,
          Arr.map(xssCorpus, ([, expected]) => expected)
        );
        assert.strictEqual(answer.allowed, allowedRichText);
        assert.isTrue(sanitizeVerdict(answer).pass);
      })
  );
});

describe("check 10 fixtures", () => {
  it("the made-up hash was made by libxcrypt for the probe input, with PHP's prefix and cost 12", () => {
    assert.isTrue(bcryptProbe.stored.startsWith(bcryptProbe.prefix));
    assert.isTrue(compareSync(bcryptProbe.right, bcryptProbe.stored));
    assert.isFalse(compareSync(bcryptProbe.wrong, bcryptProbe.stored));
  });

  it.effect(
    "the Worker verifies the right input and refuses the wrong one",
    () =>
      Effect.gen(function* verifying() {
        const right = yield* call(
          Protocol.Bcrypt,
          "POST",
          Protocol.routes.bcrypt,
          { which: "right" }
        );

        const wrong = yield* call(
          Protocol.Bcrypt,
          "POST",
          Protocol.routes.bcrypt,
          { which: "wrong" }
        );

        assert.deepStrictEqual(right, {
          cost: 12,
          prefix: "$2y$12$",
          verified: true,
        });
        assert.isFalse(wrong.verified);
      })
  );
});
