/**
 * What the tests of the two diagnostic routes (`GET /api/isolation`, spec 0018 R10; `GET /api/platform`, spec 0025 R5)
 * share: the database layer of a disposable database, the decoding of the JSON that a route sends, and the two answers
 * that do not depend on a report (an empty 404 on production, the status of a failed request).
 */
import { assert } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import { Forbidden } from "@vektorprogrammet/domain";
import { Effect, Layer, Schema } from "effect";
import type { Option, Redacted } from "effect";

import type { Outcome } from "../../src/lib/outcome";
import { failureOf } from "../../src/server/errors";

export const databaseAt = (url: Redacted.Redacted) =>
  DatabaseLive({ url }).pipe(Layer.orDie);

/** The body of a response, decoded as JSON with `body`. */
export const bodyOf = <S extends Schema.Decoder<unknown>>(
  body: S,
  response: Response
) =>
  Effect.flatMap(
    Effect.promise(async () => await response.text()),
    Schema.decodeUnknownEffect(Schema.fromJsonString(body))
  );

/** A production deployment answers an empty 404. */
export const assertEmpty404 = (response: Response) =>
  Effect.gen(function* emptyAnswer() {
    assert.strictEqual(response.status, 404);
    assert.strictEqual(
      yield* Effect.promise(async () => await response.text()),
      ""
    );
  });

/** A failed request answers with the status of its own failure (here a refusal: 403). */
export const assertFailureStatus = (
  respond: (outcome: Outcome<Option.Option<never>>) => Response
) =>
  Effect.sync(() => {
    const refused = respond(
      failureOf(new Forbidden({ command: "createDepartment" }))
    );

    assert.strictEqual(refused.status, 403);
  });
