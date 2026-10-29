/**
 * The news rules the public site still decides (spec 0005): RULE-331 which news the front page shows, RULE-326 the
 * pages of the list, and RULE-096's character mapping for an address. The articles are the CMS's, so the rules are
 * proven over plain values.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, String as Str } from "effect";

import {
  NEWS_PAGE_SIZE,
  paginate,
  selectFrontPageNews,
  slugify,
} from "../../src/index.ts";
import { at } from "../support/inMemory.ts";

const NOW = "2026-10-15T10:00:00Z";

interface Item {
  readonly id: number;
  readonly createdAt: DateTime.Utc;
  readonly published: boolean;
  readonly sticky: boolean;
}

const item = (id: number, fields: Partial<Omit<Item, "id">>): Item => ({
  createdAt: at(NOW),
  id,
  published: true,
  sticky: false,
  ...fields,
});

describe("C5 slugs", () => {
  it("RULE-096: the slug maps Norwegian letters and drops punctuation", () => {
    assert.strictEqual(slugify("Opptak åpner!"), "opptak-apner");
    assert.strictEqual(
      slugify("Ærlig talt, Øystein. Å så bra"),
      "aerlig-talt-oystein-a-sa-bra"
    );
    assert.strictEqual(slugify("  !!!  "), "artikkel");
  });

  it("RULE-096 F20: a real soft hyphen (U+00AD) is dropped, so the slug is realfagtimer (legacy left a stray dash)", () => {
    assert.strictEqual(slugify("Real\u00ADfag\u00ADtimer"), "realfagtimer");
  });

  it("RULE-096 F22: slugs are capped at 240 characters, so a -NN suffix still fits 255 (legacy could overflow)", () => {
    const title = Str.repeat(51)("abcde");
    const base = slugify(title);

    assert.strictEqual(base.length, 240);
    assert.strictEqual(base, Str.slice(0, 240)(title));
  });
});

describe("C5 front page", () => {
  it("RULE-331: shows published news from the last 30 days or sticky", () => {
    const now = at(NOW);
    const fortyDaysAgo = DateTime.subtract(now, { days: 40 });
    const a = item(1, { createdAt: fortyDaysAgo });
    const b = item(2, { createdAt: fortyDaysAgo, sticky: true });
    const recent = item(3, { createdAt: DateTime.subtract(now, { days: 2 }) });

    const recentDraft = item(4, {
      createdAt: DateTime.subtract(now, { days: 1 }),
      published: false,
    });

    const stickyDraft = item(5, {
      createdAt: fortyDaysAgo,
      published: false,
      sticky: true,
    });

    const selected = selectFrontPageNews(
      [a, b, recent, recentDraft, stickyDraft],
      now
    );

    assert.deepStrictEqual(
      Arr.map(selected, (x) => x.id),
      [b.id, recent.id]
    );
  });

  it("RULE-331: sticky first, then newest first, and the limit applies", () => {
    const now = at(NOW);
    const older = item(1, { createdAt: DateTime.subtract(now, { days: 5 }) });
    const newer = item(2, { createdAt: DateTime.subtract(now, { days: 1 }) });

    const sticky = item(3, {
      createdAt: DateTime.subtract(now, { days: 90 }),
      sticky: true,
    });

    assert.deepStrictEqual(
      Arr.map(selectFrontPageNews([older, newer, sticky], now), (x) => x.id),
      [sticky.id, newer.id, older.id]
    );
    assert.deepStrictEqual(
      Arr.map(selectFrontPageNews([older, newer, sticky], now, 2), (x) => x.id),
      [sticky.id, newer.id]
    );
  });

  it("RULE-331: the window is 30 Oslo calendar days from the given instant", () => {
    const now = at(NOW);
    const inside = item(1, { createdAt: DateTime.subtract(now, { days: 29 }) });

    const outside = item(2, {
      createdAt: DateTime.subtract(now, { days: 31 }),
    });

    assert.deepStrictEqual(
      Arr.map(selectFrontPageNews([inside, outside], now), (x) => x.id),
      [inside.id]
    );
  });
});

describe("C5 news list", () => {
  it("RULE-326: 35 published articles make 4 pages of 10, 10, 10 and 5", () => {
    const items = Arr.makeBy(35, (index) => index);

    const sizes = Arr.map(
      [1, 2, 3, 4],
      (page) => paginate(items, page).items.length
    );

    assert.deepStrictEqual(sizes, [10, 10, 10, 5]);
    assert.strictEqual(paginate(items, 1).totalPages, 4);
    assert.strictEqual(paginate(items, 5).items.length, 0);
    assert.strictEqual(NEWS_PAGE_SIZE, 10);
  });
});
