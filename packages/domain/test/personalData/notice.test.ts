/**
 * Spec 0007b falsifier 1, the generated half: the privacy notice of a form and the record of processing are plain
 * values derived from the declarations. The notice lists exactly the personal fields of its form and the retention of the
 * column that holds each; the record lists every personal column once. A text that states a period states the declared
 * one: `periodsInText.test.ts` moves every period and checks that every declared string follows.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Option,
  Order,
  Predicate,
  Record as Rec,
  String as Str,
} from "effect";

import {
  Catalog,
  ContactForm,
  NOTICE_DECISIONS,
  basesApproval,
  draftNote,
  noticeDecisionWords,
  openDecisions,
  personalColumns,
  privacyNotice,
  privacyText,
  recordOfProcessing,
  retentionIsProposed,
  retentionWordsBoth,
} from "../../src/index.ts";
import type {
  NoticeDecision,
  PersonalDataDeclaration,
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

  it("says that each recipient keeps its own copy, so the period that it states is the copy in this system and not every copy (R3 item 31)", () => {
    assert.isAbove(notice.entries.length, 0);

    for (const entry of notice.entries) {
      assert.include(entry.recipients.en, "keeps its own copy");
      assert.include(entry.recipients.en, "this system only");
      assert.include(entry.recipients.no, "egen kopi");
      assert.include(entry.recipients.no, "bare kopien i dette systemet");
    }
  });

  it("carries the fixed paragraphs of the texts", () => {
    assert.strictEqual(notice.controller, privacyText.controller);
    assert.strictEqual(notice.rights, privacyText.rights);
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

    assert.include(orphan.open, "periods");
  });
});

/** Every set of open decisions, in the order that a note names them: the eight combinations of three approvals. */
const COMBINATIONS: readonly (readonly NoticeDecision[])[] = [
  [],
  ["text"],
  ["bases"],
  ["periods"],
  ["text", "bases"],
  ["text", "periods"],
  ["bases", "periods"],
  ["text", "bases", "periods"],
];

/** What the page and the document say for each combination: one sentence that names what is open and nothing else. */
const NOTES: readonly (readonly [string | undefined, string | undefined])[] = [
  [undefined, undefined],
  [
    "Utkast: teksten venter på godkjenning.",
    "Draft, awaiting the operator's approval: the text.",
  ],
  [
    "Utkast: de rettslige grunnlagene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the legal bases.",
  ],
  [
    "Utkast: periodene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the periods.",
  ],
  [
    "Utkast: teksten og de rettslige grunnlagene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the text and the legal bases.",
  ],
  [
    "Utkast: teksten og periodene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the text and the periods.",
  ],
  [
    "Utkast: de rettslige grunnlagene og periodene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the legal bases and the periods.",
  ],
  [
    "Utkast: teksten, de rettslige grunnlagene og periodene venter på godkjenning.",
    "Draft, awaiting the operator's approval: the text, the legal bases and the periods.",
  ],
];

/** The three approvals for a set of open decisions: `proposed` for each that is in it, `decided` for the rest. */
const approvalsOf = (
  open: readonly NoticeDecision[]
): Record<NoticeDecision, PersonalDataDeclaration.Approval> => ({
  bases: open.includes("bases") ? "proposed" : "decided",
  periods: open.includes("periods") ? "proposed" : "decided",
  text: open.includes("text") ? "proposed" : "decided",
});

/** A set of decisions as text for a failure message. */
const named = (open: readonly NoticeDecision[]): string =>
  open.length === 0 ? "none" : Arr.join(open, " + ");

describe("spec 0007b R4: a notice awaits exactly the decisions that are open, and says so", () => {
  it("each of the eight combinations of the three approvals gives the decisions that are proposed, and no other", () => {
    for (const open of COMBINATIONS) {
      assert.deepStrictEqual(openDecisions(approvalsOf(open)), open);
    }
  });

  it("each combination has one sentence in each language, naming what is open and nothing else", () => {
    assert.strictEqual(COMBINATIONS.length, NOTES.length);

    for (const [index, open] of COMBINATIONS.entries()) {
      const [no, en] = NOTES[index] ?? [];
      const set = named(open);

      assert.strictEqual(draftNote(open, "no"), no, `${set} in Norwegian`);
      assert.strictEqual(draftNote(open, "en"), en, `${set} in English`);

      // The sentence names a decision exactly when it is open (the words of a closed one never stand in it).
      for (const decision of NOTICE_DECISIONS) {
        assert.strictEqual(
          Str.includes(noticeDecisionWords[decision].no)(no ?? ""),
          open.includes(decision),
          `${decision} in ${set}`
        );
      }
    }
  });

  it("the notice of the contact form awaits what its three declarations leave open", () => {
    const [, stored] = Option.getOrThrow(
      Arr.findFirst(
        personalColumns(Catalog.outbox),
        ([column]) => column === "payload"
      )
    );

    assert.deepStrictEqual(
      privacyNotice(ContactForm, Catalog).open,
      openDecisions({
        bases: basesApproval,
        periods: retentionIsProposed(stored.retention) ? "proposed" : "decided",
        text: privacyText.approval,
      })
    );
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

    assert.isFalse(
      Arr.some(without, (name) => Str.startsWith("consent.")(name))
    );
    assert.isTrue(
      Arr.some(everyColumn, (name) => Str.startsWith("consent.")(name))
    );
  });

  it("marks a row whose period is a proposal, and not one whose period is a decision", () => {
    const approvals = Arr.map(rows, (row) => row.periodApproval);

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
      Option.map(core, (row) => row.periodApproval),
      Option.some("decided")
    );
    assert.deepStrictEqual(
      Option.map(outbox, (row) => row.periodApproval),
      Option.some("proposed")
    );
  });

  it("marks every row's legal basis with the one declaration of the bases, apart from its period", () => {
    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(rows, (row) => row.basisApproval === basesApproval)
    );

    // A decided period does not decide the basis: the person's core has the one and not the other.
    const core = Arr.findFirst(rows, (row) =>
      row.data.includes("person.email")
    );

    assert.deepStrictEqual(
      Option.map(core, (row) => [row.periodApproval, row.basisApproval]),
      Option.some(["decided", basesApproval])
    );
  });
});
