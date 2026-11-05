import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import { previewVersionResponse } from "../src/routes/api/preview-version";

const headSha = "a".repeat(40);

describe("served preview revision", () => {
  it.effect(
    "reports the running preview's valid revision without caching",
    () =>
      Effect.gen(function* validPreview() {
        const response = previewVersionResponse({
          DEPLOYMENT: "preview",
          PREVIEW_HEAD_SHA: headSha,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const text = yield* Effect.promise(() => response.text());

        const body = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ headSha: Schema.String }))
        )(text);

        expect(body).toEqual({ headSha });
      })
  );

  it.effect("returns an empty 404 for non-preview or malformed revision", () =>
    Effect.gen(function* hiddenPreview() {
      const cases = [
        { DEPLOYMENT: "production", PREVIEW_HEAD_SHA: headSha },
        { DEPLOYMENT: "local", PREVIEW_HEAD_SHA: headSha },
        { DEPLOYMENT: "preview" },
        { DEPLOYMENT: "preview", PREVIEW_HEAD_SHA: "A".repeat(40) },
        { DEPLOYMENT: "preview", PREVIEW_HEAD_SHA: "a".repeat(39) },
      ];

      yield* Effect.forEach(cases, (env) =>
        Effect.gen(function* hiddenResponse() {
          const response = previewVersionResponse(env);
          expect(response.status).toBe(404);
          expect(yield* Effect.promise(() => response.text())).toBe("");
        })
      );
    })
  );
});
