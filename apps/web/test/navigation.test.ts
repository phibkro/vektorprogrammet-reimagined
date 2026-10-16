/** How a visitor finds their way: which tab a path belongs to, and the search of the pages that take one. */
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { activeTab } from "../src/components/site/siteHeader";
import { validateContactSearch } from "../src/lib/contactSearch";
import { validateNewsSearch } from "../src/lib/newsSearch";

const tabOf = (path: string) =>
  Option.map(activeTab(path), (item) => item.name);

describe("the header's active tab", () => {
  it("a page belongs to the tab of its own subtree, and an article belongs to Nyheter", () => {
    assert.deepStrictEqual(tabOf("/"), Option.some("Hjem"));
    assert.deepStrictEqual(tabOf("/om-oss"), Option.some("Om oss"));
    assert.deepStrictEqual(tabOf("/team"), Option.some("Team"));
    assert.deepStrictEqual(tabOf("/team/bergen"), Option.some("Team"));
    assert.deepStrictEqual(tabOf("/nyheter"), Option.some("Nyheter"));
    assert.deepStrictEqual(
      tabOf("/nyhet/opptak-apner"),
      Option.some("Nyheter")
    );
    assert.deepStrictEqual(tabOf("/kontakt/aas"), Option.some("Kontakt"));
  });

  it("a page outside the public site, or a path that only starts like a tab, has none", () => {
    for (const path of [
      "/kontrollpanel",
      "/kontrollpanel/avdelinger",
      "/om",
      "/teamet",
      "/nyhetsbrev",
    ]) {
      assert.isTrue(Option.isNone(activeTab(path)), path);
    }
  });
});

describe("the search of the news page", () => {
  it("keeps a department and a page after the first, and drops everything else so the URL stays /nyheter", () => {
    assert.deepStrictEqual(
      validateNewsSearch({ avdeling: "bergen", side: 3 }),
      { avdeling: "bergen", side: 3 }
    );
    assert.deepStrictEqual(
      validateNewsSearch({ avdeling: "bergen", side: "2" }),
      { avdeling: "bergen", side: 2 }
    );

    for (const search of [
      {},
      { avdeling: "", side: 1 },
      { avdeling: 5, side: -3 },
      { avdeling: ["a"], side: 2.5 },
      { side: "tekst" },
      { side: Number.NaN },
    ]) {
      assert.deepStrictEqual(
        validateNewsSearch(search),
        { avdeling: undefined, side: undefined },
        JSON.stringify(search)
      );
    }
  });
});

describe("the search of a contact page", () => {
  it("only ?sendt=1 marks the receipt", () => {
    assert.deepStrictEqual(validateContactSearch({ sendt: 1 }), { sendt: 1 });
    assert.deepStrictEqual(validateContactSearch({ sendt: "1" }), { sendt: 1 });

    for (const sendt of [0, "0", "ja", true, undefined, null]) {
      assert.deepStrictEqual(validateContactSearch({ sendt }), {});
    }
  });
});
