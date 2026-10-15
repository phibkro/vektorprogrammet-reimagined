import { assert, describe, it } from "@effect/vitest";
import { isNotFound } from "@tanstack/react-router";
import { DateTime } from "effect";
import { pageData, type Outcome } from "../src/lib/outcome";
import { articlePage, newsPage, type NewsPageView } from "../src/server/pages";
import { runOutcome } from "../src/server/runtime";
import { fakeArticle, fakeDepartment, makeTables, memoryLayer } from "./support/memory";

const signal = new AbortController().signal;
const day = (n: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1) + n * 86_400_000);

/** What a route loader does: run the page program, then `pageData` (404 → `notFound()`). */
const load = <A>(outcome: Promise<Outcome<A>>): Promise<{ data: A } | { thrown: unknown }> =>
  outcome.then((result) => {
    try {
      return { data: pageData(result) };
    } catch (thrown) {
      return { thrown };
    }
  });

describe("C5 article page (/nyhet/{slug})", () => {
  const layer = () =>
    memoryLayer(
      makeTables({
        articles: [
          fakeArticle(1, { published: false, createdAt: day(1) }),
          fakeArticle(2, { published: true, createdAt: day(2) }),
        ],
      }),
    );

  it("RULE-267: a draft's public URL is 404 at the loader (notFound)", () =>
    load(runOutcome(layer(), articlePage("nyhet-1"), signal)).then((result) => {
      assert.isTrue("thrown" in result && isNotFound(result.thrown));
    }));

  it("RULE-267: an unknown slug is 404 too", () =>
    load(runOutcome(layer(), articlePage("finnes-ikke"), signal)).then((result) => {
      assert.isTrue("thrown" in result && isNotFound(result.thrown));
    }));

  it("RULE-267: a published article renders, with sanitized body HTML", () =>
    load(runOutcome(layer(), articlePage("nyhet-2"), signal)).then((result) => {
      assert.isTrue("data" in result);
      if ("data" in result) {
        assert.strictEqual(result.data.title, "Nyhet 2");
        assert.strictEqual(result.data.bodyHtml, "<p>Tekst 2</p>");
        assert.strictEqual(result.data.date, "03.01.2026");
      }
    }));

  it("RULE-267: drafts never appear in the news list", () =>
    load(runOutcome(layer(), newsPage({ page: 1, department: null }), signal)).then((result) => {
      assert.isTrue("data" in result);
      if ("data" in result)
        assert.deepStrictEqual(
          result.data.items.map((item) => item.slug),
          ["nyhet-2"],
        );
    }));
});

describe("C5 news list (/nyheter)", () => {
  // 35 published articles, one per day, plus drafts that must not count.
  const tables = () =>
    makeTables({
      departments: [fakeDepartment(1, "Trondheim"), fakeDepartment(2, "Bergen")],
      articles: [
        ...Array.from({ length: 35 }, (_, index) =>
          fakeArticle(index + 1, {
            published: true,
            createdAt: day(index),
            departmentIds: index % 5 === 0 ? [2] : [],
          }),
        ),
        fakeArticle(100, { published: false, createdAt: day(50) }),
      ],
    });

  const page = (number: number, department: string | null = null) =>
    load(runOutcome(memoryLayer(tables()), newsPage({ page: number, department }), signal));

  const view = (result: { data: NewsPageView } | { thrown: unknown }): NewsPageView => {
    if ("data" in result) return result.data;
    throw new Error("expected page data");
  };

  it("RULE-326: 35 published articles give 4 pages of 10, 10, 10 and 5", () =>
    Promise.all([page(1), page(2), page(3), page(4)]).then((results) => {
      const views = results.map(view);
      assert.deepStrictEqual(
        views.map((v) => v.items.length),
        [10, 10, 10, 5],
      );
      assert.deepStrictEqual(
        views.map((v) => v.totalPages),
        [4, 4, 4, 4],
      );
      assert.strictEqual(views[0]?.totalItems, 35);
    }));

  it("RULE-326: newest first across pages", () =>
    Promise.all([page(1), page(4)]).then(([first, last]) => {
      assert.strictEqual(view(first!).items[0]?.slug, "nyhet-35");
      assert.strictEqual(view(last!).items.at(-1)?.slug, "nyhet-1");
    }));

  it("RULE-326: a page past the end is empty, not an error", () =>
    page(5).then((result) => assert.deepStrictEqual(view(result).items, [])));

  it("/nyheter/{department}: tagged with the department or untagged; an unknown department is 404", () =>
    Promise.all([page(1, "TRON"), page(1, "ukjent")]).then(([tagged, unknown]) => {
      // Articles 1, 6, 11, … are tagged Bergen only, so Trondheim sees 35 - 7 = 28.
      assert.strictEqual(view(tagged!).totalItems, 28);
      assert.isTrue(unknown !== undefined && "thrown" in unknown && isNotFound(unknown.thrown));
    }));
});
