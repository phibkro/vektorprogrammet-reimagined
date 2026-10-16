import { assert, describe, it } from "@effect/vitest";
import { isNotFound } from "@tanstack/react-router";
import { Array as Arr, DateTime, Effect } from "effect";

import { pageData } from "../src/lib/outcome";
import type { Outcome } from "../src/lib/outcome";
import { articlePage, newsPage } from "../src/server/pages";
import type { NewsPageView } from "../src/server/pages";
import { runOutcome } from "../src/server/runtime";
import {
  fakeArticle,
  fakeDepartment,
  makeTables,
  memoryLayer,
} from "./support/memory";

const { signal } = new AbortController();

const day = (n: number) =>
  DateTime.makeUnsafe(Date.UTC(2026, 0, 1) + n * 86_400_000);

const mapPage = <A>(result: Outcome<A>) => {
  try {
    return { data: pageData(result) };
  } catch (error) {
    return { thrown: error };
  }
};

/** The route loader maps page outcomes, preserving not-found responses. */
const load = <A>(outcome: Promise<Outcome<A>>) =>
  Effect.gen(function* loadPageOutcome() {
    const result = yield* Effect.promise(async () => await outcome);

    return mapPage(result);
  });

const articleLayer = () =>
  memoryLayer(
    makeTables({
      articles: [
        fakeArticle(1, { createdAt: day(1), published: false }),
        fakeArticle(2, { createdAt: day(2), published: true }),
      ],
    })
  );

const newsTables = () =>
  makeTables({
    articles: [
      ...Array.from({ length: 35 }, (_, index) =>
        fakeArticle(index + 1, {
          createdAt: day(index),
          departmentIds: index % 5 === 0 ? [2] : [],
          published: true,
        })
      ),
      fakeArticle(100, { createdAt: day(50), published: false }),
    ],
    departments: [fakeDepartment(1, "Trondheim"), fakeDepartment(2, "Bergen")],
  });

const view = (
  result: { data: NewsPageView } | { thrown: unknown }
): NewsPageView => {
  if ("data" in result) {
    return result.data;
  }

  throw new Error("expected page data");
};

const page = (number: number, department: string | null = null) =>
  load(
    runOutcome(
      memoryLayer(newsTables()),
      newsPage({ department, page: number }),
      signal
    )
  );

describe("C5 article page (/nyhet/{slug})", () => {
  it.effect(
    "RULE-267: a draft's public URL is 404 at the loader (notFound)",
    () =>
      Effect.gen(function* draftArticle404() {
        const result = yield* load(
          runOutcome(articleLayer(), articlePage("nyhet-1"), signal)
        );

        assert.isTrue("thrown" in result && isNotFound(result.thrown));
      })
  );

  it.effect("RULE-267: an unknown slug is 404 too", () =>
    Effect.gen(function* unknownArticle404() {
      const result = yield* load(
        runOutcome(articleLayer(), articlePage("finnes-ikke"), signal)
      );

      assert.isTrue("thrown" in result && isNotFound(result.thrown));
    })
  );

  it.effect(
    "RULE-267: a published article renders, with sanitized body HTML",
    () =>
      Effect.gen(function* publishedArticle() {
        const result = yield* load(
          runOutcome(articleLayer(), articlePage("nyhet-2"), signal)
        );

        assert.isTrue("data" in result);

        if ("data" in result && result.data !== undefined) {
          assert.strictEqual(result.data.title, "Nyhet 2");
          assert.strictEqual(result.data.bodyHtml, "<p>Tekst 2</p>");
          assert.strictEqual(result.data.date, "03.01.2026");
        }
      })
  );

  it.effect("RULE-267: drafts never appear in the news list", () =>
    Effect.gen(function* draftExcludedFromNews() {
      const result = yield* load(
        runOutcome(
          articleLayer(),
          newsPage({ department: null, page: 1 }),
          signal
        )
      );

      assert.isTrue("data" in result);

      if ("data" in result && result.data !== undefined) {
        assert.deepStrictEqual(
          Arr.map(result.data.items, (item) => item.slug),
          ["nyhet-2"]
        );
      }
    })
  );
});

describe("C5 news list (/nyheter)", () => {
  it.effect(
    "RULE-326: 35 published articles give 4 pages of 10, 10, 10 and 5",
    () =>
      Effect.gen(function* newsPagination() {
        const results = yield* Effect.all(
          [page(1), page(2), page(3), page(4)],
          { concurrency: "unbounded" }
        );

        const views = Arr.map(results, view);
        assert.deepStrictEqual(
          Arr.map(views, (v) => v.items.length),
          [10, 10, 10, 5]
        );
        assert.deepStrictEqual(
          Arr.map(views, (v) => v.totalPages),
          [4, 4, 4, 4]
        );
        assert.strictEqual(views[0]?.totalItems, 35);
      })
  );

  it.effect("RULE-326: newest first across pages", () =>
    Effect.gen(function* newestArticleFirst() {
      const [first, last] = yield* Effect.all([page(1), page(4)], {
        concurrency: "unbounded",
      });

      assert.strictEqual(view(first).items[0]?.slug, "nyhet-35");
      assert.strictEqual(view(last).items.at(-1)?.slug, "nyhet-1");
    })
  );

  it.effect("RULE-326: a page past the end is empty, not an error", () =>
    Effect.gen(function* pagePastEnd() {
      const result = yield* page(5);
      assert.deepStrictEqual(view(result).items, []);
    })
  );

  it.effect(
    "/nyheter/{department}: tagged with the department or untagged; an unknown department is 404",
    () =>
      Effect.gen(function* departmentNews() {
        const [tagged, unknown] = yield* Effect.all(
          [page(1, "TRON"), page(1, "ukjent")],
          { concurrency: "unbounded" }
        );

        // Articles 1, 6, 11, … are tagged Bergen only, so Trondheim sees 35 - 7 = 28.
        assert.strictEqual(view(tagged).totalItems, 28);
        assert.isTrue(
          unknown !== undefined &&
            "thrown" in unknown &&
            isNotFound(unknown.thrown)
        );
      })
  );
});
