import { assert, describe, it } from "@effect/vitest";
import { servePublicFile, type FileKey, type PublicFile } from "@vektorprogrammet/domain";
import { DateTime } from "effect";
import { publicFileResponse } from "../src/server/publicFiles";
import { runOutcome } from "../src/server/runtime";
import { fakeKey, makeTables, memoryLayer } from "./support/memory";

const signal = new AbortController().signal;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OPAQUE = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e]); // "<svg>": stored as opaque bytes

const file = (
  key: FileKey,
  name: string,
  contentType: PublicFile["contentType"],
  size: number,
): PublicFile => ({
  key,
  name,
  contentType,
  size,
  uploadedBy: null,
  legacyPath: null,
  uploadedAt: DateTime.makeUnsafe("2026-10-01T10:00:00Z"),
});

const pngKey = fakeKey(1, "png");
const binKey = fakeKey(2, "bin");
const unregisteredKey = fakeKey(3, "png");

const layer = () =>
  memoryLayer(
    makeTables({
      publicFiles: [
        file(pngKey, "logo.png", "image/png", PNG.byteLength),
        file(binKey, "skjema.svg", "application/octet-stream", OPAQUE.byteLength),
      ],
      objects: new Map([
        [pngKey, PNG],
        [binKey, OPAQUE],
        [unregisteredKey, PNG],
      ]),
    }),
  );

const get = (key: string, method = "GET") =>
  runOutcome(layer(), servePublicFile(key), signal).then((outcome) =>
    publicFileResponse(outcome, method),
  );

describe("/filer/{key} (RULE-290 replacement)", () => {
  it("RULE-290: an image is served inline with nosniff, a sandbox CSP and an immutable cache lifetime", () =>
    get(pngKey).then((response) => {
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("Content-Type"), "image/png");
      assert.match(response.headers.get("Content-Disposition") ?? "", /^inline;/);
      assert.strictEqual(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.strictEqual(
        response.headers.get("Content-Security-Policy"),
        "sandbox; default-src 'none'",
      );
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "public, max-age=31536000, immutable",
      );
      return response
        .arrayBuffer()
        .then((body) => assert.deepStrictEqual(new Uint8Array(body), PNG));
    }));

  it("RULE-290: any type outside JPEG/PNG/WebP/GIF/PDF is an attachment", () =>
    get(binKey).then((response) => {
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get("Content-Disposition") ?? "", /^attachment;/);
      assert.strictEqual(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.strictEqual(
        response.headers.get("Content-Security-Policy"),
        "sandbox; default-src 'none'",
      );
    }));

  it("RULE-290: an unregistered key is 404 even when the object exists in the bucket", () =>
    get(unregisteredKey).then((response) => {
      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.strictEqual(
        response.headers.get("Content-Security-Policy"),
        "sandbox; default-src 'none'",
      );
    }));

  it("RULE-290: a path instead of a key is 404 (no path traversal by construction)", () =>
    Promise.all([get("../../etc/passwd"), get("Offentlige filer/x.pdf")]).then((responses) =>
      assert.deepStrictEqual(
        responses.map((response) => response.status),
        [404, 404],
      ),
    ));

  it("RULE-290: HEAD answers the headers without a body", () =>
    get(pngKey, "HEAD").then((response) => {
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body, null);
    }));
});
