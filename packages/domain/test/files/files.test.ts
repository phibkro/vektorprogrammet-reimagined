import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result, Stream } from "effect";
import {
  IMAGE_OR_PDF_REQUIRED_MESSAGE,
  anonymous,
  classifyUpload,
  detectContentType,
  registerPublicFile,
  resolveLegacyFilePath,
  servePublicFile,
  servingHeaders,
  storeUpload,
  type DomainError,
  type PublicFile,
} from "../../src/index.ts";
import {
  TestServices,
  admin,
  asActor,
  at,
  failureTag,
  seed,
  table,
  teamMemberBergen,
} from "../support/inMemory.ts";

const bytes = (...values: ReadonlyArray<number | string>): Uint8Array =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === "number" ? [value] : Array.from(value, (char) => char.charCodeAt(0)),
    ),
  );

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, "JFIF");
const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, "IHDR");
const GIF = bytes("GIF89a", 1, 0, 1, 0);
const WEBP = bytes("RIFF", 0x24, 0, 0, 0, "WEBPVP8 ");
const PDF = bytes("%PDF-1.7\n%âãÏÓ\n");
// A .docx is a ZIP container.
const DOCX = bytes("PK", 0x03, 0x04, 0x14, 0, 0x06, 0, "[Content_Types].xml");
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const HTML = bytes("<!doctype html><script>alert(1)</script>");

const messageOf = (error: DomainError) =>
  error._tag === "ValidationFailed" ? error.issues.map((issue) => issue.message) : [];

describe("C11 file types by magic bytes", () => {
  it("RULE-130: detects JPEG, PNG, WebP, GIF and PDF from the bytes, not the name", () => {
    assert.strictEqual(detectContentType(JPEG), "image/jpeg");
    assert.strictEqual(detectContentType(PNG), "image/png");
    assert.strictEqual(detectContentType(WEBP), "image/webp");
    assert.strictEqual(detectContentType(GIF), "image/gif");
    assert.strictEqual(detectContentType(PDF), "application/pdf");
    assert.strictEqual(detectContentType(DOCX), "application/octet-stream");
    assert.strictEqual(detectContentType(new Uint8Array()), "application/octet-stream");
  });

  it("RULE-130: 'kvittering.docx' is refused with 'Filtypen må være et bilde eller PDF.'", () => {
    const result = classifyUpload(DOCX, "imageOrPdf");
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.deepStrictEqual(messageOf(result.failure), [IMAGE_OR_PDF_REQUIRED_MESSAGE]);
  });

  it("RULE-130: a JPEG or a PDF is accepted", () => {
    assert.deepStrictEqual(classifyUpload(JPEG, "imageOrPdf"), Result.succeed("image/jpeg"));
    assert.deepStrictEqual(classifyUpload(PDF, "imageOrPdf"), Result.succeed("application/pdf"));
  });

  it("RULE-130: SVG and HTML are refused as images (legacy accepted any image/*)", () => {
    assert.isTrue(Result.isFailure(classifyUpload(SVG, "imageOrPdf")));
    assert.isTrue(Result.isFailure(classifyUpload(HTML, "image")));
    assert.isTrue(Result.isFailure(classifyUpload(PDF, "image")));
  });
});

describe("C11 upload and serving", () => {
  it.effect("RULE-130: storeUpload refuses a non-image for an image slot and stores nothing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          storeUpload({ name: "kvittering.docx", bytes: DOCX, accept: "imageOrPdf" }),
        ),
      );
      assert.deepStrictEqual(messageOf(error), [IMAGE_OR_PDF_REQUIRED_MESSAGE]);
      assert.strictEqual((yield* table((db) => db.objects)).size, 0);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-290: upload is content-addressed, registered, audited and served inline", () =>
    Effect.gen(function* () {
      const stored = yield* asActor(admin)(
        storeUpload({ name: "plakat.png", bytes: PNG, accept: "image" }),
      );
      assert.match(stored.key, /^[0-9a-f]{64}\.png$/);
      const again = yield* asActor(admin)(
        storeUpload({ name: "kopi.png", bytes: PNG, accept: "image" }),
      );
      assert.strictEqual(again.key, stored.key);
      const registered = yield* asActor(admin)(registerPublicFile(stored));
      assert.strictEqual(registered.uploadedBy, admin.userId);
      const served = yield* servePublicFile(stored.key);
      const body = yield* Stream.runCollect(served.body);
      assert.deepStrictEqual(body, [PNG]);
      assert.strictEqual(served.headers["Content-Type"], "image/png");
      assert.isTrue(served.headers["Content-Disposition"]?.startsWith("inline;"));
      assert.strictEqual(served.headers["X-Content-Type-Options"], "nosniff");
      assert.strictEqual(served.headers["Content-Security-Policy"], "sandbox");
      const audit = yield* table((db) => db.audit);
      assert.deepStrictEqual(
        audit.map((e) => [e.action, e.entityKey]),
        [["publicFile.registered", stored.key]],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-290: an object in the store that is not registered is unreachable", () =>
    Effect.gen(function* () {
      const stored = yield* asActor(admin)(
        storeUpload({ name: "plakat.png", bytes: PNG, accept: "image" }),
      );
      assert.strictEqual(failureTag(yield* Effect.exit(servePublicFile(stored.key))), "NotFound");
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-290: path-like and malformed keys are NotFound by construction", () =>
    Effect.gen(function* () {
      for (const key of [
        "../../app/config/parameters.yml",
        "..%2F..%2Fetc%2Fpasswd",
        "",
        "Offentlige filer/x.pdf",
      ]) {
        assert.strictEqual(failureTag(yield* Effect.exit(servePublicFile(key))), "NotFound", key);
      }
    }).pipe(Effect.provide(TestServices)),
  );

  it("RULE-290: everything outside the inline allowlist is served as an attachment", () => {
    const file = (contentType: PublicFile["contentType"]) => ({
      name: "Årsrapport 2025.docx",
      contentType,
      size: 3,
    });
    const attachment = servingHeaders(file("application/octet-stream"));
    assert.isTrue(attachment["Content-Disposition"]?.startsWith("attachment;"));
    assert.isTrue(
      attachment["Content-Disposition"]?.includes("filename*=UTF-8''%C3%85rsrapport%202025.docx"),
    );
    assert.strictEqual(attachment["X-Content-Type-Options"], "nosniff");
    assert.strictEqual(attachment["Content-Security-Policy"], "sandbox");
    for (const inline of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
    ] as const) {
      assert.isTrue(
        servingHeaders(file(inline))["Content-Disposition"]?.startsWith("inline;"),
        inline,
      );
    }
  });

  it.effect("RULE-290: legacy 'Offentlige filer' paths resolve through the registry only", () =>
    Effect.gen(function* () {
      const stored = yield* asActor(admin)(
        storeUpload({ name: "vedtekter.pdf", bytes: PDF, accept: "any" }),
      );
      yield* seed.publicFile({
        key: stored.key,
        name: "vedtekter.pdf",
        contentType: stored.contentType,
        size: stored.size,
        uploadedBy: null,
        legacyPath: "Offentlige filer/vedtekter.pdf",
        uploadedAt: at("2024-08-22T00:00:00Z"),
      });
      assert.deepStrictEqual(
        yield* resolveLegacyFilePath("Offentlige filer/vedtekter.pdf"),
        Option.some(stored.key),
      );
      assert.isTrue(
        Option.isNone(yield* resolveLegacyFilePath("Offentlige filer/../app/config.yml")),
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("only staff may upload", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        asActor(anonymous)(storeUpload({ name: "x.png", bytes: PNG, accept: "image" })),
      );
      assert.strictEqual(failureTag(exit), "Forbidden");
    }).pipe(Effect.provide(TestServices)),
  );
});
