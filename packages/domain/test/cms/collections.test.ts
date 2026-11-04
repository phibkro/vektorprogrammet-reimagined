import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { COLLECTIONS } from "../../src/cms/index.ts";

describe("site content schemas", () => {
  it("accepts valid collection data and rejects a malformed news item", () => {
    assert.isTrue(
      Schema.is(COLLECTIONS.texts)({ content: [], title: "Velkommen" })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.news)({ sticky: true, title: "Nyhet" })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.sponsors)({
        name: "Partner",
        size: "small",
        url: "https://example.org",
      })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.faq)({
        answer: "Svar",
        page: "team",
        position: 1,
        question: "Hva?",
      })
    );
    assert.isTrue(
      Schema.is(COLLECTIONS.teams)({
        department: "Oslo",
        name: "Team",
        position: 1,
      })
    );
    assert.isFalse(Schema.is(COLLECTIONS.news)({ title: 42 }));
  });
});
