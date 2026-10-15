import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";
import {
  LEGACY_FILE_PREFIXES,
  classifyLegacyPath,
  legacyFileLocation,
  permanentRedirect,
} from "../src/server/redirects";
import { runOutcome } from "../src/server/runtime";
import { fakeKey, makeTables, memoryLayer } from "./support/memory";

const signal = new AbortController().signal;

describe("legacy URLs answer permanent redirects (spec §4 URLs)", () => {
  it("/om, /bedrifter and /faq → /omvektor", () => {
    for (const path of ["/om", "/bedrifter", "/faq", "/om/"]) {
      assert.deepStrictEqual(classifyLegacyPath(path, ""), {
        _tag: "Alias",
        location: "/omvektor",
      });
    }
  });

  it("/artikkel/{slug} → /nyhet/{slug}, keeping the query", () => {
    assert.deepStrictEqual(classifyLegacyPath("/artikkel/opptak-apner", "?ref=epost"), {
      _tag: "Alias",
      location: "/nyhet/opptak-apner?ref=epost",
    });
  });

  it("answers 301 with the location", () => {
    const response = permanentRedirect("/omvektor");
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("Location"), "/omvektor");
  });

  it("current paths are not redirected", () => {
    for (const path of ["/", "/omvektor", "/nyhet/opptak-apner", "/kontakt", "/omx", "/artikkel"]) {
      assert.deepStrictEqual(classifyLegacyPath(path, ""), { _tag: "None" });
    }
  });

  it("legacy file paths are decoded relative to the legacy web root", () => {
    assert.deepStrictEqual(LEGACY_FILE_PREFIXES, [
      "Offentlige filer/",
      "images/article_images/",
      "images/Logo images/",
    ]);
    assert.deepStrictEqual(classifyLegacyPath("/Offentlige%20filer/Styret/referat.pdf", ""), {
      _tag: "LegacyFile",
      legacyPath: "Offentlige filer/Styret/referat.pdf",
    });
    assert.deepStrictEqual(classifyLegacyPath("/images/Logo%20images/sponsor.png", ""), {
      _tag: "LegacyFile",
      legacyPath: "images/Logo images/sponsor.png",
    });
  });

  it("traversal, empty segments and malformed escapes are never looked up", () => {
    for (const path of [
      "/Offentlige%20filer/../../secret",
      "/Offentlige%20filer/a//b.pdf",
      "/Offentlige%20filer/%E0%A4%A",
      "/images/receipts/kvittering.jpg",
    ]) {
      assert.deepStrictEqual(classifyLegacyPath(path, ""), { _tag: "None" });
    }
  });

  it("a registered legacy file redirects to /filer/{key}; an unknown one does not", () => {
    const key = fakeKey(7, "pdf");
    const layer = memoryLayer(
      makeTables({
        publicFiles: [
          {
            key,
            name: "referat.pdf",
            contentType: "application/pdf",
            size: 10,
            uploadedBy: null,
            legacyPath: "Offentlige filer/Styret/referat.pdf",
            uploadedAt: DateTime.makeUnsafe("2024-08-22T00:00:00Z"),
          },
        ],
      }),
    );
    return Promise.all([
      runOutcome(layer, legacyFileLocation("Offentlige filer/Styret/referat.pdf"), signal),
      runOutcome(layer, legacyFileLocation("Offentlige filer/finnes-ikke.pdf"), signal),
    ]).then(([found, missing]) => {
      assert.deepStrictEqual(found, { _tag: "Success", value: Option.some(`/filer/${key}`) });
      assert.deepStrictEqual(missing, { _tag: "Success", value: Option.none() });
    });
  });
});
