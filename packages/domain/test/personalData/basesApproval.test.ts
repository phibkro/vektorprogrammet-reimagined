/**
 * Spec 0007b R3 item 32 and R4: what a notice awaits follows the three declarations that it rests on, one by one: the
 * approval of its text (`privacyText.approval`), of the legal bases (`basesApproval`) and of the periods that it states.
 * Each case evaluates the domain again with those declarations replaced. Three cases leave one proposal open, and a
 * fourth leaves none. The notice then awaits exactly the open decisions, and each row of the record reflects its own.
 * The combinations of approvals and the sentence for each are in `notice.test.ts`. The declarations are constants of two
 * modules, so the cases are made here, once, before the tests, as `periodsInText.test.ts` makes its second evaluation
 * (two evaluations of one module graph cannot be two static imports).
 */
// oxlint-disable anti-slop/no-module-mocking -- EX-0027: the guard evaluates the declarations a second time with their approvals replaced, and they reach every text only through modules.
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Record as Rec } from "effect";
import { vi } from "vite-plus/test";

import type { PersonalDataDeclaration } from "../../src/index.ts";
import * as RealPeriods from "../../src/personalData/periods.ts";
import * as RealTexts from "../../src/personalData/texts.ts";

type Approval = PersonalDataDeclaration.Approval;

const PERIODS = "../../src/personalData/periods.ts";
const TEXTS = "../../src/personalData/texts.ts";

/** Every period with this approval. */
const periodsWith = (approval: Approval) => ({
  Periods: Rec.map(RealPeriods.Periods, (period) => ({ ...period, approval })),
});

/** The texts with the approval of the bases and of the notice's own text replaced. */
const textsWith = (bases: Approval, text: Approval) => ({
  ...RealTexts,
  basesApproval: bases,
  privacyText: { ...RealTexts.privacyText, approval: text },
});

vi.resetModules();

vi.doMock(PERIODS, () => periodsWith("decided"));

vi.doMock(TEXTS, () => textsWith("decided", "decided"));

const NoneOpen = await import("../../src/index.ts");

vi.resetModules();

vi.doMock(PERIODS, () => periodsWith("decided"));

vi.doMock(TEXTS, () => textsWith("proposed", "decided"));

const OnlyBases = await import("../../src/index.ts");

vi.resetModules();

vi.doMock(PERIODS, () => periodsWith("decided"));

vi.doMock(TEXTS, () => textsWith("decided", "proposed"));

const OnlyText = await import("../../src/index.ts");

vi.resetModules();

vi.doMock(PERIODS, () => periodsWith("proposed"));

vi.doMock(TEXTS, () => textsWith("decided", "decided"));

const OnlyPeriods = await import("../../src/index.ts");

/** The notice of the contact form and the rows of the record, in one evaluation of the domain. */
const readings = (domain: typeof NoneOpen) => ({
  open: domain.privacyNotice(domain.ContactForm, domain.Catalog).open,
  rows: domain.recordOfProcessing(domain.Catalog),
});

describe("spec 0007b R3 item 32 and R4: a notice and the record await the decisions that are open", () => {
  it("with the text, the bases and every period decided, the notice awaits nothing and no row has an open decision (the control of the others)", () => {
    const { open, rows } = readings(NoneOpen);

    assert.deepStrictEqual(open, []);
    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "decided" && row.periodApproval === "decided"
      )
    );
  });

  it("with only the bases proposed, the notice awaits the bases, and every row says its basis is, apart from its period", () => {
    const { open, rows } = readings(OnlyBases);

    assert.deepStrictEqual(open, ["bases"]);
    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "proposed" && row.periodApproval === "decided"
      )
    );
  });

  it("with only the notice's text proposed, the notice awaits its text and no row has an open decision", () => {
    const { open, rows } = readings(OnlyText);

    assert.deepStrictEqual(open, ["text"]);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "decided" && row.periodApproval === "decided"
      )
    );
  });

  it("with only the periods proposed, the notice awaits its periods, and every row says its period is, apart from its basis", () => {
    const { open, rows } = readings(OnlyPeriods);

    assert.deepStrictEqual(open, ["periods"]);
    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "decided" && row.periodApproval === "proposed"
      )
    );
  });
});
