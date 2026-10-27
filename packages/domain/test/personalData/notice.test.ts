/**
 * Spec 0007b falsifier 1, the generated half: the privacy notice of a form and the record of processing are plain
 * values derived from the declarations. The notice lists exactly the personal fields of its form and the retention of the
 * column that holds each; the record lists every personal column once. A text that states a period states the declared
 * one: `periodsInText.test.ts` moves every period and checks that every declared string follows.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Option, Order, Predicate, Record as Rec } from "effect";

import {
  Catalog,
  ContactForm,
  personalColumns,
  privacyNotice,
  privacyText,
  recordOfProcessing,
  retentionWordsBoth,
} from "../../src/index.ts";

describe("spec 0007b falsifier 1: the privacy notice", () => {
  const notice = privacyNotice(ContactForm, Catalog);

  it("lists exactly the personal fields of the form, in the order of its declaration", () => {
    assert.deepStrictEqual(
      Arr.map(notice.entries, (entry) => entry.field),
      ["email", "message", "name", "subject"]
    );

    // `departmentId` is declared, and is the organisation's own: it is not in the notice.
    assert.include(Rec.keys(ContactForm.fields), "departmentId");

    assert.isFalse(
      Arr.some(notice.entries, (entry) => entry.field === "departmentId")
    );
  });

  it("states the retention of the column that holds each field, as the retention job applies it", () => {
    const payload = Arr.findFirst(
      personalColumns(Catalog.outbox),
      ([column]) => column === "payload"
    );

    assert.isTrue(Option.isSome(payload));
    const [, stored] = Option.getOrThrow(payload);

    for (const entry of notice.entries) {
      assert.deepStrictEqual(
        entry.kept,
        retentionWordsBoth(stored.retention, false)
      );
    }
  });

  it("carries the fixed paragraphs of the texts, and says it is a draft while a text or a period is a proposal", () => {
    assert.strictEqual(notice.controller, privacyText.controller);
    assert.strictEqual(notice.rights, privacyText.rights);
    assert.strictEqual(notice.approval, "proposed");
  });

  it("negative control: a form with no personal field has no entry, and a field of an undeclared column says so", () => {
    const empty = privacyNotice(
      {
        ...ContactForm,
        fields: Rec.filter(ContactForm.fields, (field) =>
          Predicate.isTagged(field, "NotPersonal")
        ),
      },
      Catalog
    );

    assert.deepStrictEqual(empty.entries, []);

    const orphan = privacyNotice(ContactForm, Rec.remove(Catalog, "outbox"));

    assert.isTrue(
      Arr.every(orphan.entries, (entry) => entry.kept.en === "not declared")
    );

    assert.strictEqual(orphan.approval, "proposed");
  });
});

describe("spec 0007b falsifier 1: the record of processing", () => {
  const rows = recordOfProcessing(Catalog);

  const everyColumn = Arr.flatMap(
    Rec.toEntries(Catalog),
    ([stored, declaration]) =>
      Arr.map(personalColumns(declaration), ([column]) => `${stored}.${column}`)
  );

  it("lists every personal column of the catalog exactly once, and nothing else", () => {
    const listed = Arr.flatMap(rows, (row) => row.data);

    assert.deepStrictEqual(
      Arr.sort(listed, Order.String),
      Arr.sort(everyColumn, Order.String)
    );
  });

  it("negative control: a table taken out of the catalog takes its columns out of the record", () => {
    const without = Arr.flatMap(
      recordOfProcessing(Rec.remove(Catalog, "consent")),
      (row) => row.data
    );

    assert.isFalse(Arr.some(without, (name) => name.startsWith("consent.")));
    assert.isTrue(Arr.some(everyColumn, (name) => name.startsWith("consent.")));
  });

  it("marks a row that rests on a proposal, and not one that rests on a decision", () => {
    const approvals = Arr.map(rows, (row) => row.approval);

    assert.include(approvals, "proposed");
    assert.include(approvals, "decided");

    // The person's core is a decision of the operator (§11.9); the outbox's period is a proposal.
    const core = Arr.findFirst(rows, (row) =>
      row.data.includes("person.email")
    );

    const outbox = Arr.findFirst(rows, (row) =>
      row.data.includes("outbox.payload")
    );

    assert.deepStrictEqual(
      Option.map(core, (row) => row.approval),
      Option.some("decided")
    );
    assert.deepStrictEqual(
      Option.map(outbox, (row) => row.approval),
      Option.some("proposed")
    );
  });
});
