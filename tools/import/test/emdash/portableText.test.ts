import { assert, describe, it } from "@effect/vitest";
import { PortableText } from "@vektorprogrammet/cms-client";
import {
  Array as Arr,
  Effect,
  Option,
  Predicate,
  Schema,
  String as Str,
} from "effect";

import { htmlToPortableText } from "../../src/emdash/portableText.ts";
import type { Block } from "../../src/emdash/portableText.ts";

const encodeJson = Schema.encodeEffect(
  Schema.fromJsonString(PortableText.PortableText)
);

/** A text block as `[style or list, [text, ...marks] per span]`, with link marks written `link(href)`. */
const plain = (block: Block) => {
  if (block._type !== "block") {
    return block._type;
  }

  const links = new Map(
    Arr.map(
      block.markDefs ?? [],
      (definition) =>
        [
          definition._key,
          `link(${Predicate.isString(definition.href) ? definition.href : "?"})`,
        ] as const
    )
  );

  return [
    block.listItem === undefined
      ? block.style
      : `${block.listItem}:${block.level}`,
    Arr.map(block.children, (span) => [
      span.text,
      ...Arr.map(span.marks ?? [], (mark) => links.get(mark) ?? mark),
    ]),
  ];
};

describe("htmlToPortableText", () => {
  it("keeps paragraphs, headings and inline marks", () => {
    const { blocks, imagesDropped } = htmlToPortableText(
      "<h2>Om oss</h2><p>Hei <strong>du</strong>, <em>og</em> <u>du</u>.</p>"
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      ["h2", [["Om oss"]]],
      [
        "normal",
        [
          ["Hei "],
          ["du", "strong"],
          [", "],
          ["og", "em"],
          [" "],
          ["du", "underline"],
          ["."],
        ],
      ],
    ]);
    assert.strictEqual(imagesDropped, 0);
  });

  it("writes a link as a mark that refers to its definition", () => {
    const { blocks } = htmlToPortableText(
      '<p><a href="https://example.org/a">en</a> og <a href="mailto:kontakt@example.org">to</a></p>'
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      [
        "normal",
        [
          ["en", "link(https://example.org/a)"],
          [" og "],
          ["to", "link(mailto:kontakt@example.org)"],
        ],
      ],
    ]);
  });

  it("flattens lists into blocks with a kind and a level", () => {
    const { blocks } = htmlToPortableText(
      "<ul><li>A</li><li>B<ul><li>B1</li></ul></li></ul><ol><li>Ett</li></ol>"
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      ["bullet:1", [["A"]]],
      ["bullet:1", [["B"]]],
      ["bullet:2", [["B1"]]],
      ["number:1", [["Ett"]]],
    ]);
  });

  it("makes every paragraph of a blockquote a blockquote block", () => {
    const { blocks } = htmlToPortableText(
      "<blockquote><p>Sitat</p><p>Mer</p></blockquote>"
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      ["blockquote", [["Sitat"]]],
      ["blockquote", [["Mer"]]],
    ]);
  });

  it("keeps preformatted text as a code block and a rule as a break", () => {
    const { blocks } = htmlToPortableText("<pre>a &lt; b\nc</pre><hr>");

    assert.deepStrictEqual(Arr.map(blocks, plain), ["code", "break"]);
    assert.strictEqual(
      blocks[0]?._type === "code" ? blocks[0].code : undefined,
      "a < b\nc"
    );
  });

  it("writes a table with its header row, spans and cell text", () => {
    const { blocks } = htmlToPortableText(
      '<table><thead><tr><th>Navn</th><th colspan="2">Info</th></tr></thead>' +
        "<tbody><tr><td>A</td><td><strong>B</strong></td><td>C</td></tr></tbody></table>"
    );

    const [table] = blocks;
    const rows = table?._type === "table" ? table.rows : [];

    assert.strictEqual(
      table?._type === "table" ? table.hasHeaderRow : undefined,
      true
    );
    assert.deepStrictEqual(
      Arr.map(rows, (row) =>
        Arr.map(row.cells, (cell) => [
          Arr.join(
            Arr.map(cell.content, (span) => span.text),
            ""
          ),
          cell.isHeader,
          cell.colspan,
        ])
      ),
      [
        [
          ["Navn", true, 1],
          ["Info", true, 2],
        ],
        [
          ["A", false, 1],
          ["B", false, 1],
          ["C", false, 1],
        ],
      ]
    );
  });

  it("drops images and counts them; a figure keeps its caption", () => {
    const { blocks, imagesDropped } = htmlToPortableText(
      '<p>Før<img src="https://x.example/a.png">Etter</p>' +
        '<figure><img src="https://x.example/b.png"><figcaption>Bildetekst</figcaption></figure>' +
        '<img src="https://x.example/c.png">'
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      ["normal", [["FørEtter"]]],
      ["normal", [["Bildetekst"]]],
    ]);
    assert.strictEqual(imagesDropped, 3);
  });

  it("collapses whitespace, keeps a <br> as a line break and decodes entities", () => {
    const { blocks } = htmlToPortableText(
      "<p>  linje en<br>linje to  \n  tre </p><p>Tom &amp; Jerry &lt;3</p>"
    );

    assert.deepStrictEqual(Arr.map(blocks, plain), [
      ["normal", [["linje en\nlinje to tre"]]],
      ["normal", [["Tom & Jerry <3"]]],
    ]);
  });

  it("wraps text outside any block in a paragraph, and gives nothing for blank input", () => {
    assert.deepStrictEqual(
      Arr.map(htmlToPortableText("Bare tekst<p>Avsnitt</p>").blocks, plain),
      [
        ["normal", [["Bare tekst"]]],
        ["normal", [["Avsnitt"]]],
      ]
    );
    assert.deepStrictEqual(htmlToPortableText("").blocks, []);
    assert.deepStrictEqual(htmlToPortableText("<p> </p>\n<p></p>").blocks, []);
  });

  it.effect(
    "produces what the CMS client decodes, with unique keys, the same every time",
    () =>
      Effect.gen(function* decodable() {
        const html =
          '<h3>Tittel</h3><p>A <a href="https://example.org">b</a></p><ul><li>x</li></ul>' +
          "<table><tbody><tr><td>c</td></tr></tbody></table><hr><pre>d</pre>";

        const first = htmlToPortableText(html).blocks;
        const text = yield* encodeJson(first);

        assert.deepStrictEqual(
          yield* Schema.decodeEffect(
            Schema.fromJsonString(PortableText.PortableText)
          )(text),
          first
        );
        assert.deepStrictEqual(htmlToPortableText(html).blocks, first);

        const keys = Arr.map(
          Arr.fromIterable(Str.matchAll(/"_key":"(?<key>[^"]+)"/gu)(text)),
          (match) => match.groups?.key
        );

        assert.strictEqual(new Set(keys).size, keys.length);
        assert.isTrue(Option.isSome(Arr.head(keys)));
      })
  );
});
