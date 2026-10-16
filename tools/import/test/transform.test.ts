/** Pure mapping functions: legacy file references, rich text, date-times and the target guard. */
import { assert, describe, it } from "@effect/vitest";
import { FileKey } from "@vektorprogrammet/domain";
import { DateTime, Option, Predicate, Redacted } from "effect";

import { checkTarget, sameDatabase } from "../src/config.ts";
import type { LegacyReference } from "../src/transform/legacyPath.ts";
import { classifyReference } from "../src/transform/legacyPath.ts";
import { parseLegacyDateTime } from "../src/transform/plan.ts";
import { importRichText } from "../src/transform/richText.ts";

const KEY = FileKey.make(
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg`
);

const assertFileReference = (reference: LegacyReference, path: string) => {
  if (Predicate.isTagged(reference, "File")) {
    assert.strictEqual(reference.path, path);
  } else {
    assert.fail(`expected file reference, received ${reference._tag}`);
  }
};

const assertUnmappableReference = (
  reference: LegacyReference,
  area: string
) => {
  if (Predicate.isTagged(reference, "Unmappable")) {
    assert.strictEqual(reference.area, area);
  } else {
    assert.fail(`expected unmappable reference, received ${reference._tag}`);
  }
};

const formatInstant = (text: string) =>
  Option.map(
    Option.fromNullishOr(parseLegacyDateTime(text)),
    DateTime.formatIso
  );

describe("legacy file references", () => {
  it("normalise site paths, percent-encoding and the legacy host to one legacy_path", () => {
    assertFileReference(
      classifyReference("/Offentlige filer/Styret/referat.pdf"),
      "Offentlige filer/Styret/referat.pdf"
    );
    assertFileReference(
      classifyReference("/Offentlige%20filer/Styret/referat.pdf"),
      "Offentlige filer/Styret/referat.pdf"
    );
    assertFileReference(
      classifyReference(
        "https://www.vektorprogrammet.no/Offentlige%20filer/Styret/referat.pdf?v=2#s"
      ),
      "Offentlige filer/Styret/referat.pdf"
    );
    assertFileReference(
      classifyReference("/images/Logo images/x.png"),
      "images/Logo images/x.png"
    );
  });

  it("leave other hosts, relative and protocol-relative URLs alone", () => {
    for (const url of [
      "https://example.org/images/article_images/x.jpg",
      "images/article_images/x.jpg",
      "//vektorprogrammet.no/images/article_images/x.jpg",
      "mailto:post@example.org",
      "/nyheter",
    ]) {
      assert.strictEqual(classifyReference(url)._tag, "NotLegacy", url);
    }
  });

  it("never resolve traversal, malformed encoding or assets outside the upload roots", () => {
    assertUnmappableReference(
      classifyReference("/images/article_images/../../app/config.yml"),
      "images/article_images"
    );
    assertUnmappableReference(
      classifyReference("/Offentlige filer/%E0%A4%A.pdf"),
      "Offentlige filer"
    );
    assertUnmappableReference(
      classifyReference("/images/team_images/x.png"),
      "images/team_images"
    );
  });
});

describe("rich text (RULE-133 replacement)", () => {
  it("RULE-133: sanitises, then rewrites resolved references and keeps missing ones", () => {
    const imported = importRichText(
      '<p onclick="x()">a</p><img src="/images/article_images/a.jpg?x=1&amp;y=2"><img src="/images/article_images/b.jpg"><script>alert(1)</script>',
      (path) => (path === "images/article_images/a.jpg" ? KEY : undefined)
    );

    assert.strictEqual(
      imported.html,
      `<p>a</p><img src="/filer/${KEY}" /><img src="/images/article_images/b.jpg" />`
    );
    assert.isTrue(imported.sanitizerChanged);
    assert.strictEqual(imported.rewritten, 1);
    assert.deepStrictEqual(imported.missing, ["images/article_images/b.jpg"]);
  });

  it("RULE-133: a script's src is removed with the script, not reported as a missing file", () => {
    const imported = importRichText(
      '<script src="/images/article_images/x.js"></script>',
      () => {}
    );

    assert.strictEqual(imported.html, "");
    assert.deepStrictEqual(imported.missing, []);
  });
});

describe("legacy DATETIME", () => {
  it("is Oslo wall-clock time, across daylight saving", () => {
    assert.deepStrictEqual(
      formatInstant("2024-07-01 12:00:00"),
      Option.some("2024-07-01T10:00:00.000Z")
    );
    assert.deepStrictEqual(
      formatInstant("2024-01-01 00:00:00"),
      Option.some("2023-12-31T23:00:00.000Z")
    );
  });

  it("zero and impossible dates are invalid, never guessed", () => {
    for (const text of [
      "0000-00-00 00:00:00",
      "2024-02-30 10:00:00",
      "2024-13-01 10:00:00",
      "",
      "2024-01-01",
    ]) {
      assert.isUndefined(parseLegacyDateTime(text), text);
    }
  });
});

describe("target guard", () => {
  const development = "postgres://127.0.0.1:54321/vektorprogrammet";

  it("recognises the development database behind loopback aliases and default ports", () => {
    assert.isTrue(
      sameDatabase(development, "postgres://localhost:54321/vektorprogrammet")
    );
    assert.isFalse(
      sameDatabase(development, "postgres://127.0.0.1:54321/import_rehearsal")
    );
    assert.isTrue(
      sameDatabase("postgres://db.example/x", "postgresql://db.example:5432/x")
    );
  });

  it("refuses the development database unless --allow-dev-database is given", () => {
    const config = {
      developmentUrl: Option.some(Redacted.make(development)),
      targetUrl: Redacted.make("postgres://localhost:54321/vektorprogrammet"),
    };

    assert.isTrue(Option.isSome(checkTarget(config, false)));
    assert.isTrue(Option.isNone(checkTarget(config, true)));
    assert.isTrue(
      Option.isNone(
        checkTarget(
          {
            ...config,
            targetUrl: Redacted.make("postgres://neon.example/branch"),
          },
          false
        )
      )
    );
    assert.isTrue(
      Option.isNone(
        checkTarget({ ...config, developmentUrl: Option.none() }, false)
      )
    );
  });
});
