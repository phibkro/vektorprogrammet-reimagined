import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { SanitizedHtml, sanitizeRichText } from "../../src/index.ts";

describe("RULE-133 rich-text sanitizer (replacement: maintained allowlist)", () => {
  const xss: readonly (readonly [string, string])[] = [
    ["<script>alert(1)</script><p>ok</p>", "<p>ok</p>"],
    ['<img src="x" onerror="alert(1)">', '<img src="x" />'],
    ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
    ['<svg onload="alert(1)"><circle /></svg>', ""],
    ['<object data="evil.swf"></object>', ""],
    ['<iframe src="https://evil.example"></iframe>', ""],
    ['<p style="background:url(javascript:alert(1))">x</p>', "<p>x</p>"],
    ['<img src="data:image/png;base64,AAAA">', "<img />"],
    ['<a href="//evil.example/x">x</a>', "<a>x</a>"],
  ];

  it("RULE-133: strips scripts, event handlers, javascript: URLs, svg, object, iframe and styles", () => {
    for (const [input, expected] of xss) {
      assert.strictEqual(sanitizeRichText(input), expected, input);
    }
  });

  it("RULE-133: keeps editor tags, http/https/mailto links, images and tables", () => {
    const html =
      '<h2>Tittel</h2><p><strong>Fet</strong> <em>kursiv</em> <a href="https://vektorprogrammet.no/om">lenke</a> ' +
      '<a href="mailto:post@example.org">e-post</a></p><ul><li>én</li></ul>' +
      '<img src="/filer/abc.png" alt="Bilde" />' +
      '<table><thead><tr><th colspan="2">A</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';

    assert.strictEqual(sanitizeRichText(html), html);
  });

  it("RULE-133: sanitizing is idempotent, so its output is SanitizedHtml", () => {
    for (const [input] of xss) {
      const once = sanitizeRichText(input);
      assert.strictEqual(sanitizeRichText(once), once);
      assert.isTrue(Schema.is(SanitizedHtml)(once));
    }

    assert.isFalse(Schema.is(SanitizedHtml)("<script>x</script>"));
  });
});
