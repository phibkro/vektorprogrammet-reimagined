/**
 * What an editor writes in the CMS reaches the public page as Portable Text, rendered by `PortableTextView`.
 * RULE-133 (the legacy `SafeHtmlExtension`) asked that rich text on a public page carries no script, no event
 * handler and no `javascript:` link. The new text has no HTML to sanitize: a block is data, a link is rendered
 * only for an address the page may link to, and a block type the page does not know is skipped.
 */
import { assert, describe, it } from "@effect/vitest";
import type { PortableText } from "@vektorprogrammet/cms-client";
import { Option } from "effect";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PortableTextView,
  safeHref,
} from "../src/components/site/portableTextView";

const render = (
  value: readonly PortableText.PortableTextBlock[] | null,
  tone: "dark" | "light" = "light"
) => renderToStaticMarkup(<PortableTextView tone={tone} value={value} />);

/** A paragraph whose text is a link to `href`. */
const linked = (href: string): PortableText.PortableTextBlock => ({
  _type: "block",
  children: [{ _type: "span", marks: ["link"], text: "Lenke" }],
  markDefs: [{ _key: "link", _type: "link", href }],
  style: "normal",
});

describe("RULE-133: rich text on a public page", () => {
  it("a javascript: address is shown as plain text, not as a link", () => {
    const html = render([linked("javascript:alert(3)")]);

    assert.include(html, "Lenke");
    assert.notInclude(html, "<a");
    assert.notInclude(html, "javascript:");
  });

  it("no other scheme than http, https, mailto and tel is a link, and a protocol-relative address is not one", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example/x",
    ]) {
      assert.isTrue(Option.isNone(safeHref(href)), href);
    }
  });

  it("http, https, mailto, tel, site-relative and fragment addresses are links; an external one opens apart", () => {
    for (const href of [
      "https://example.org/side",
      "HTTP://example.org",
      "mailto:post@example.org",
      "tel:+4712345678",
      "/om-oss",
      "#spørsmål",
    ]) {
      assert.deepStrictEqual(
        Option.map(safeHref(href), String),
        Option.some(href)
      );
    }

    assert.deepStrictEqual(
      safeHref("  https://example.org  "),
      Option.some("https://example.org")
    );

    const external = render([linked("https://example.org")]);
    assert.include(external, 'href="https://example.org"');
    assert.include(external, 'rel="noopener noreferrer"');
    assert.include(external, 'target="_blank"');

    const internal = render([linked("/om-oss")]);
    assert.include(internal, 'href="/om-oss"');
    assert.notInclude(internal, "target=");
  });

  it("raw HTML never reaches the page: an htmlBlock is skipped and markup in a text is escaped", () => {
    const html = render([
      { _type: "htmlBlock", html: "<script>alert(1)</script>" },
      {
        _type: "block",
        children: [{ _type: "span", text: '<img src="x" onerror="alert(2)">' }],
        style: "normal",
      },
    ]);

    assert.notInclude(html, "<script");
    assert.notInclude(html, "<img");
    assert.include(html, "&lt;img");
  });
});

describe("the blocks of a text", () => {
  it("a block type the page does not know is skipped, and the rest still renders", () => {
    const html = render([
      { _type: "videoEmbed", url: "https://example.org/v" },
      {
        _type: "block",
        children: [{ _type: "span", text: "Etter" }],
        style: "normal",
      },
    ]);

    assert.include(html, "Etter");
    assert.notInclude(html, "example.org/v");
  });

  it("headings, lists and marks render as the design's elements", () => {
    const html = render([
      {
        _type: "block",
        children: [{ _type: "span", text: "Tittel" }],
        style: "h2",
      },
      {
        _type: "block",
        children: [{ _type: "span", text: "Ett" }],
        level: 1,
        listItem: "bullet",
        style: "normal",
      },
      {
        _type: "block",
        children: [{ _type: "span", marks: ["strong", "em"], text: "Fet" }],
        style: "normal",
      },
    ]);

    assert.match(html, /<h2[^>]*>Tittel<\/h2>/u);
    assert.match(html, /<ul[^>]*><li[^>]*>Ett<\/li><\/ul>/u);
    assert.include(html, "<strong><em>Fet</em></strong>");
  });

  it("a table renders its header cells as th and its links with the same rule", () => {
    const html = render([
      {
        _type: "table",
        markDefs: [{ _key: "bad", _type: "link", href: "javascript:alert(1)" }],
        rows: [
          {
            cells: [
              { content: [{ _type: "span", text: "Navn" }], isHeader: true },
            ],
          },
          {
            cells: [
              {
                content: [{ _type: "span", marks: ["bad"], text: "Ola" }],
                markDefs: [
                  { _key: "bad", _type: "link", href: "javascript:alert(1)" },
                ],
              },
            ],
          },
        ],
      },
    ]);

    assert.match(html, /<th[^>]*>Navn<\/th>/u);
    assert.match(html, /<td[^>]*>Ola<\/td>/u);
    assert.notInclude(html, "javascript:");
  });

  it("an image shows its picture from the address it carries, and none without one", () => {
    const shown = render([
      {
        _type: "image",
        alt: "Elever",
        asset: {
          _ref: "m1",
          url: "https://cms.example/_emdash/api/media/file/m1",
        },
        caption: "Første dag",
      },
    ]);

    assert.include(
      shown,
      'src="https://cms.example/_emdash/api/media/file/m1"'
    );
    assert.include(shown, 'alt="Elever"');
    assert.include(shown, "Første dag");
    assert.notInclude(
      render([{ _type: "image", asset: { _ref: "m2" } }]),
      "<img"
    );
  });

  it("no text, or an empty one, renders nothing", () => {
    assert.strictEqual(render(null), "");
    assert.strictEqual(render([]), "");
  });

  it("on the dark band the text and the headings take the light colour", () => {
    const html = render(
      [
        {
          _type: "block",
          children: [{ _type: "span", text: "Tittel" }],
          style: "h1",
        },
      ],
      "dark"
    );

    assert.include(html, "text-vektor-bg");
  });
});
