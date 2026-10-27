/**
 * Spec 0007b, the web side: what a click on a consent question sends, what an erasure tells the person, and the file of
 * the export. The rules themselves are the domain's and the database's, and have their own tests; these pin the form text
 * and the answers that the pages show.
 */
import { assert, describe, it } from "@effect/vitest";
import { PersonalDataRpcs } from "@vektorprogrammet/domain";
import { DateTime, Effect, Record as Rec } from "effect";

import { success } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";
import {
  consentAnswers,
  erasureMessage,
  exportResponse,
} from "../src/server/personalData";

const clicked = (fields: Readonly<Record<string, string>>): FormData => {
  const form = new FormData();

  for (const [name, value] of Rec.toEntries(fields)) {
    form.set(name, value);
  }

  return form;
};

describe("spec 0007b: one click answers one question", () => {
  it("a click sends the box it is on and nothing about the other", () => {
    const news = consentAnswers(clicked({ answer: "yes", kind: "news" }));
    const keep = consentAnswers(clicked({ answer: "no", kind: "keepDetails" }));

    assert.deepStrictEqual(news, { news: true });
    assert.deepStrictEqual(keep, { keepDetails: false });
    // Negative control: the other box is absent, not false, so the command leaves its record as it was.
    assert.notProperty(news, "keepDetails");
    assert.notProperty(keep, "news");
  });

  it("a form that names no box, an unknown box or no clear answer answers nothing", () => {
    const unclear: readonly Readonly<Record<string, string>>[] = [
      {},
      { answer: "yes" },
      { kind: "news" },
      { answer: "yes", kind: "photo" },
      { answer: "maybe", kind: "news" },
      { answer: "", kind: "keepDetails" },
    ];

    for (const fields of unclear) {
      assert.deepStrictEqual(
        consentAnswers(clicked(fields)),
        {},
        JSON.stringify(fields)
      );
    }
  });
});

describe("spec 0007b: what an erasure tells the person", () => {
  it("says that it is done, that there was nothing to do, or what the law keeps and until when", () => {
    assert.include(erasureMessage({ erased: true, held: [] }), "er slettet");
    assert.include(erasureMessage({ erased: false, held: [] }), "ingenting");

    const kept = erasureMessage({
      erased: true,
      held: [
        {
          reason: "Utlegg under regnskapsoppbevaring",
          source: "claims",
          until: DateTime.makeUnsafe("2031-12-31T00:00:00Z"),
        },
        { reason: "En sak som ikke har en dato", source: "other", until: null },
      ],
    });

    assert.include(kept, "Utlegg under regnskapsoppbevaring (til 2031-12-31)");
    assert.include(kept, "En sak som ikke har en dato");
    assert.notInclude(kept, "(til null)");
  });
});

describe("spec 0007b: the download", () => {
  it.effect(
    "a file is an attachment that is never cached; a refusal is the refusal",
    () =>
      Effect.gen(function* downloads() {
        const file = exportResponse(
          success({ body: '{"personId":1}', filename: "mine-data-1.json" })
        );

        assert.strictEqual(file.status, 200);
        assert.strictEqual(
          file.headers.get("content-disposition"),
          'attachment; filename="mine-data-1.json"'
        );
        assert.strictEqual(file.headers.get("cache-control"), "no-store");
        assert.include(
          file.headers.get("content-type") ?? "",
          "application/json"
        );
        assert.strictEqual(
          yield* Effect.promise(() => file.text()),
          '{"personId":1}'
        );

        const refused = exportResponse(
          failureOf(
            PersonalDataRpcs.PersonalDataDomain.forbidden("exportMyData")
          )
        );

        assert.strictEqual(refused.status, 403);
        assert.isNull(refused.headers.get("content-disposition"));
      })
  );
});
