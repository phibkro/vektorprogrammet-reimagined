/** The CMS half of the import as a pure function: what each legacy row becomes, and why a row is refused. */
import { assert, describe, it } from "@effect/vitest";
import { PortableText } from "@vektorprogrammet/cms-client";
import { Array as Arr, DateTime, Schema } from "effect";

import { planEmDashContent } from "../../src/emdash/plan.ts";
import type {
  LegacyArticle,
  LegacySnapshot,
  LegacySponsor,
  LegacyStaticContent,
} from "../../src/legacy/rows.ts";
import { NO_ROWS, legacyDepartment } from "../support/legacyRows.ts";

const IMPORTED_AT = DateTime.makeUnsafe("2024-10-16T12:00:00.000Z");

const isTextBlock = Schema.is(PortableText.TextBlock);

const article = (
  id: number,
  overrides: Partial<LegacyArticle> = {}
): LegacyArticle => ({
  authorId: 42,
  body: "<p>Tekst</p>",
  created: "2024-01-15 12:00:00",
  id,
  imageLarge: "/images/article_images/stor.jpg",
  imageSmall: "/images/article_images/liten.jpg",
  published: 1,
  slug: `artikkel-${id}`,
  sticky: 0,
  title: `Tittel ${id}`,
  ...overrides,
});

const text = (
  id: number,
  htmlId: string,
  html = "<p>Tekst</p>"
): LegacyStaticContent => ({ html, htmlId, id });

const sponsor = (
  id: number,
  overrides: Partial<LegacySponsor> = {}
): LegacySponsor => ({
  id,
  logoImagePath: null,
  name: `Sponsor ${id}`,
  size: "medium",
  url: `https://sponsor-${id}.example`,
  ...overrides,
});

const plan = (rows: Partial<LegacySnapshot>) =>
  planEmDashContent({ ...NO_ROWS, ...rows }, IMPORTED_AT);

describe("the CMS import plan: articles", () => {
  it("RULE-267: a published article goes live, a draft or an article with no published flag stays a draft", () => {
    const { news } = plan({
      articles: [
        article(1, { sticky: 1 }),
        article(2, { published: 0 }),
        article(3, { published: null }),
      ],
    });

    assert.deepStrictEqual(
      Arr.map(news, (entry) => [entry.slug, entry.publish, entry.data.sticky]),
      [
        ["artikkel-1", true, true],
        ["artikkel-2", false, false],
        ["artikkel-3", false, false],
      ]
    );
  });

  it("keeps the legacy created date, in UTC, as both the creation and the publication date", () => {
    const [first] = plan({ articles: [article(1)] }).news;

    assert.strictEqual(
      first === undefined ? "" : DateTime.formatIso(first.createdAt),
      "2024-01-15T11:00:00.000Z"
    );
    assert.deepStrictEqual(first?.publishedAt, first?.createdAt);
  });

  it("turns department tags into city names; an untagged article is for every department", () => {
    const { news, danglingDepartmentTags } = plan({
      articleDepartments: [
        { articleId: 1, departmentId: 1 },
        { articleId: 1, departmentId: 2 },
        { articleId: 2, departmentId: 99 },
      ],
      articles: [article(1), article(2), article(3)],
      departments: [
        legacyDepartment(1, "Trondheim"),
        legacyDepartment(2, "Bergen"),
      ],
    });

    assert.deepStrictEqual(
      Arr.map(news, (entry) => entry.data.departments),
      [["Trondheim", "Bergen"], [], []]
    );
    assert.strictEqual(danglingDepartmentTags, 1);
  });

  it("refuses an article with an unusable title, slug or date, naming the columns and never the values", () => {
    const { news, quarantine } = plan({
      articles: [
        article(1),
        article(2, { slug: "artikkel-1" }),
        article(3, { slug: "Ikke en slug", title: "" }),
        article(4, { created: "i går", title: "Hemmelig tittel" }),
        article(5, { published: 7, sticky: 2 }),
      ],
    });

    assert.deepStrictEqual(
      Arr.map(news, (entry) => entry.slug),
      ["artikkel-1"]
    );
    assert.deepStrictEqual(
      Arr.map(quarantine, ({ collection, id, reasons }) => [
        collection,
        id,
        ...reasons,
      ]),
      [
        ["news", "2", "slug duplicates article 1"],
        [
          "news",
          "3",
          "title is empty",
          "slug is not a URL slug ([a-z0-9-], at most 255)",
        ],
        ["news", "4", "created is not a valid date-time"],
        ["news", "5", "sticky is not 0 or 1", "published is not 0, 1 or NULL"],
      ]
    );
    assert.isTrue(
      Arr.every(quarantine, (row) =>
        Arr.every(row.reasons, (reason) => !reason.includes("Hemmelig"))
      )
    );
  });

  it("sanitizes the body before converting it, so scripts and handlers never reach the CMS", () => {
    const [first] = plan({
      articles: [
        article(1, {
          body: '<p onclick="steal()">Hei</p><script>alert(1)</script>',
        }),
      ],
    }).news;

    const [block] = first?.data.content ?? [];

    assert.deepStrictEqual(
      block !== undefined && isTextBlock(block)
        ? Arr.map(block.children, (span) => span.text)
        : [],
      ["Hei"]
    );
  });
});

describe("the CMS import plan: texts and sponsors", () => {
  it("uses the html_id as the entry slug and gives the legacy keys an editor title", () => {
    const { texts } = plan({
      staticContents: [text(1, "home-tagline"), text(2, "about-intro")],
    });

    assert.deepStrictEqual(
      Arr.map(texts, (entry) => [entry.slug, entry.data.title, entry.publish]),
      [
        ["home-tagline", "Hjem: undertittel", true],
        ["about-intro", "about-intro", true],
      ]
    );
  });

  it("created texts and sponsors at the import time, which the caller supplies", () => {
    const { texts, sponsors } = plan({
      sponsors: [sponsor(1)],
      staticContents: [text(1, "home-tagline")],
    });

    assert.deepStrictEqual(
      [texts[0]?.createdAt, sponsors[0]?.createdAt],
      [IMPORTED_AT, IMPORTED_AT]
    );
  });

  it("refuses a repeated key and a key the CMS cannot use as a slug", () => {
    const { texts, quarantine } = plan({
      staticContents: [
        text(1, "about-intro"),
        text(2, "about-intro"),
        text(3, "Om Oss"),
        text(4, ""),
      ],
    });

    assert.deepStrictEqual(
      Arr.map(texts, (entry) => entry.slug),
      ["about-intro"]
    );
    assert.deepStrictEqual(
      Arr.map(quarantine, ({ id, reasons }) => [id, ...reasons]),
      [
        ["2", "html_id duplicates static_content 1"],
        ["3", "html_id is not a CMS slug ([a-z0-9_-], at most 50)"],
        ["4", "html_id is not a CMS slug ([a-z0-9_-], at most 50)"],
      ]
    );
  });

  it("gives a sponsor the slug sponsor-{id} and refuses one without a name, an http(s) URL or a known size", () => {
    const { sponsors, quarantine } = plan({
      sponsors: [
        sponsor(1),
        sponsor(2, { url: "www.uten-skjema.example" }),
        sponsor(3, { size: "gigantic" }),
        sponsor(4, { name: null }),
        sponsor(5, { url: null }),
      ],
    });

    assert.deepStrictEqual(
      Arr.map(sponsors, (entry) => [entry.slug, entry.data.size]),
      [["sponsor-1", "medium"]]
    );
    assert.deepStrictEqual(
      Arr.map(quarantine, ({ id, reasons }) => [id, ...reasons]),
      [
        ["2", "url is not an absolute http(s) URL"],
        ["3", "size is not small, medium or large"],
        ["4", "name is empty"],
        ["5", "url is not an absolute http(s) URL"],
      ]
    );
  });
});

describe("the CMS import plan", () => {
  it("drops images and counts them: article images, images in rich text and sponsor logos", () => {
    const { droppedImages, news } = plan({
      articles: [
        article(1, {
          body: '<p>A</p><img src="https://x.example/a.png"><p>B<img src="https://x.example/b.png"></p>',
        }),
        article(2, { imageLarge: "", imageSmall: "" }),
      ],
      sponsors: [sponsor(1, { logoImagePath: "/images/Logo images/a.png" })],
    });

    assert.deepStrictEqual(droppedImages, {
      articles: 1,
      richText: 2,
      sponsors: 1,
    });
    assert.deepStrictEqual(
      Arr.map(news, (entry) => entry.data.image),
      [undefined, undefined]
    );
  });

  it("counts the rows it was given per collection, quarantined or not", () => {
    const { rowsIn } = plan({
      articles: [article(1), article(2, { title: "" })],
      sponsors: [sponsor(1)],
      staticContents: [text(1, "a"), text(2, "a"), text(3, "b")],
    });

    assert.deepStrictEqual(rowsIn, { news: 2, sponsors: 1, texts: 3 });
  });

  it("is a function of the snapshot and the import time", () => {
    const rows = {
      articleDepartments: [{ articleId: 1, departmentId: 1 }],
      articles: [article(1), article(2, { published: 0 })],
      departments: [legacyDepartment(1, "Trondheim")],
      sponsors: [sponsor(1)],
      staticContents: [text(1, "home-tagline")],
    };

    assert.deepStrictEqual(plan(rows), plan(rows));
  });
});
