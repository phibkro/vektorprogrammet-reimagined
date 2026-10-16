import { assert, describe, it } from "@effect/vitest";
import { servePublicFile } from "@vektorprogrammet/domain";
import type { FileKey, PublicFile } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";

import { publicFileResponse } from "../src/server/publicFiles";
import { runOutcome } from "../src/server/runtime";
import { fakeKey, makeTables, memoryLayer } from "./support/memory";

const { signal } = new AbortController();

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const OPAQUE = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e]);
// "<svg>": stored as opaque bytes

const file = (
  key: FileKey,
  name: string,
  contentType: PublicFile["contentType"],
  size: number
): PublicFile => ({
  contentType,
  key,
  legacyPath: null,
  name,
  size,
  uploadedAt: DateTime.makeUnsafe("2026-10-01T10:00:00Z"),
  uploadedBy: null,
});

const pngKey = fakeKey(1, "png");

const binKey = fakeKey(2, "bin");

const unregisteredKey = fakeKey(3, "png");

const layer = () =>
  memoryLayer(
    makeTables({
      objects: new Map([
        [pngKey, PNG],
        [binKey, OPAQUE],
        [unregisteredKey, PNG],
      ]),
      publicFiles: [
        file(pngKey, "logo.png", "image/png", PNG.byteLength),
        file(
          binKey,
          "skjema.svg",
          "application/octet-stream",
          OPAQUE.byteLength
        ),
      ],
    })
  );

const get = (key: string, method = "GET") =>
  Effect.gen(function* publicFileRequest() {
    const outcome = yield* Effect.promise(
      async () => await runOutcome(layer(), servePublicFile(key), signal)
    );

    return publicFileResponse(outcome, method);
  });

const assertSecurityHeaders = (response: Response) => {
  assert.strictEqual(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.strictEqual(
    response.headers.get("Content-Security-Policy"),
    "sandbox; default-src 'none'"
  );
};

describe("/filer/{key} (RULE-290 replacement)", () => {
  it.effect(
    "RULE-290: an image is served inline with nosniff, a sandbox CSP and an immutable cache lifetime",
    () =>
      Effect.gen(function* inlineFileResponse() {
        const response = yield* get(pngKey);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("Content-Type"), "image/png");
        assert.match(
          response.headers.get("Content-Disposition") ?? "",
          /^inline;/u
        );
        assert.strictEqual(
          response.headers.get("X-Content-Type-Options"),
          "nosniff"
        );
        assert.strictEqual(
          response.headers.get("Content-Security-Policy"),
          "sandbox; default-src 'none'"
        );
        assert.strictEqual(
          response.headers.get("Cache-Control"),
          "public, max-age=31536000, immutable"
        );
        assert.deepStrictEqual(
          new Uint8Array(
            yield* Effect.promise(async () => await response.arrayBuffer())
          ),
          PNG
        );
      })
  );

  it.effect(
    "RULE-290: any type outside JPEG/PNG/WebP/GIF/PDF is an attachment",
    () =>
      Effect.gen(function* attachmentResponse() {
        const response = yield* get(binKey);
        assert.strictEqual(response.status, 200);
        assert.match(
          response.headers.get("Content-Disposition") ?? "",
          /^attachment;/u
        );
        assertSecurityHeaders(response);
      })
  );

  it.effect(
    "RULE-290: an unregistered key is 404 even when the object exists in the bucket",
    () =>
      Effect.gen(function* unregisteredFile() {
        const response = yield* get(unregisteredKey);
        assert.strictEqual(response.status, 404);
        assertSecurityHeaders(response);
      })
  );

  it.effect(
    "RULE-290: a path instead of a key is 404 (no path traversal by construction)",
    () =>
      Effect.gen(function* unsafeFilePaths() {
        const responses = yield* Effect.all(
          [get("../../etc/passwd"), get("Offentlige filer/x.pdf")],
          { concurrency: "unbounded" }
        );

        assert.deepStrictEqual(
          Arr.map(responses, (response) => response.status),
          [404, 404]
        );
      })
  );

  it.effect("RULE-290: HEAD answers the headers without a body", () =>
    Effect.gen(function* headResponse() {
      const response = yield* get(pngKey, "HEAD");
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, null);
    })
  );
});
