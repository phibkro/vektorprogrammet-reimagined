/**
 * Spec 0007b R3 item 32: the legal bases of the record of processing have an approval of their own (`basesApproval`),
 * apart from the approval of each period and of the notice's text. The notice and every row of the record follow it: with
 * every period and the notice's text decided, the notice is still a draft while only the bases are proposed, and it is
 * final when the bases are decided too. The declarations are constants of two modules, so each case evaluates the domain
 * again with those modules replaced, as `periodsInText.test.ts` does (two evaluations of one module graph cannot be two
 * static imports, so they are made here, once, before the tests).
 */
// oxlint-disable anti-slop/no-module-mocking -- EX-0027: the guard evaluates the declarations a second time with their approvals replaced, and they reach every text only through modules.
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Record as Rec } from "effect";
import { vi } from "vite-plus/test";

import * as Real from "../../src/index.ts";
import * as RealPeriods from "../../src/personalData/periods.ts";
import * as RealTexts from "../../src/personalData/texts.ts";

const decidedPeriods = {
  Periods: Rec.map(RealPeriods.Periods, (period) => ({
    ...period,
    approval: "decided" as const,
  })),
};

const textsWith = (bases: "decided" | "proposed") => ({
  ...RealTexts,
  basesApproval: bases,
  privacyText: { ...RealTexts.privacyText, approval: "decided" as const },
});

vi.resetModules();

vi.doMock("../../src/personalData/periods.ts", () => decidedPeriods);

vi.doMock("../../src/personalData/texts.ts", () => textsWith("decided"));

const AllDecided = await import("../../src/index.ts");

vi.resetModules();

vi.doMock("../../src/personalData/periods.ts", () => decidedPeriods);

vi.doMock("../../src/personalData/texts.ts", () => textsWith("proposed"));

const OnlyBasesProposed = await import("../../src/index.ts");

describe("spec 0007b R3 item 32: the legal bases have an approval of their own", () => {
  it("with the bases, every period and the text decided, the notice is final and no row has an open decision (the control of the next test)", () => {
    const { Catalog, ContactForm, privacyNotice, recordOfProcessing } =
      AllDecided;

    assert.strictEqual(privacyNotice(ContactForm, Catalog).approval, "decided");

    const rows = recordOfProcessing(Catalog);

    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "decided" && row.periodApproval === "decided"
      )
    );
  });

  it("with only the bases proposed, the notice is a draft and every row says its basis is, apart from its period", () => {
    const { Catalog, ContactForm, privacyNotice, recordOfProcessing } =
      OnlyBasesProposed;

    assert.strictEqual(
      privacyNotice(ContactForm, Catalog).approval,
      "proposed"
    );

    const rows = recordOfProcessing(Catalog);

    assert.isAbove(rows.length, 0);
    assert.isTrue(
      Arr.every(
        rows,
        (row) =>
          row.basisApproval === "proposed" && row.periodApproval === "decided"
      )
    );
  });

  it("negative control: the declarations as they are leave the bases proposed, so the two cases above are not the default", () => {
    assert.strictEqual(Real.basesApproval, "proposed");

    assert.isTrue(
      Arr.every(
        Real.recordOfProcessing(Real.Catalog),
        (row) => row.basisApproval === "proposed"
      )
    );
  });
});
