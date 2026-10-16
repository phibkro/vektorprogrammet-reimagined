/**
 * P0 rules exercised through web code: the panel's server-side view programs,
 * its form mapping and the per-request runtime. RULE-033 (the calendar month's
 * semester), RULE-130 (upload typing) and RULE-296 (who may edit static text).
 * RULE-133 (rich text on a public page) moved with the public pages to
 * `portableTextView.test.tsx`. The domain-level proofs of the same rules live
 * in `packages/domain`.
 */
import { assert, describe, it } from "@effect/vitest";
import { updateStaticContent } from "@vektorprogrammet/domain";
import type { Actor, StoredUpload } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Layer, Predicate } from "effect";
import { TestClock } from "effect/testing";

import { TEST_ACTORS } from "../src/server/actor";
import {
  dashboardView,
  readFile,
  staticContentInput,
  storeOptional,
} from "../src/server/panel";
import { runCommandOutcome } from "../src/server/runtime";
import { webCryptoLayer } from "../src/server/webCrypto";
import { form, makeTables, memoryLayer } from "./support/memory";
import { assertValidationFailure } from "./support/outcomes";

const { signal } = new AbortController();

// ---------------------------------------------------------------- RULE-033

/** The RULE-033 cut-over: January–July is Vår, August–December is Høst. */
const SEMESTER_BY_OSLO_DATE = [
  {
    at: "2026-07-31T23:59:00+02:00",
    expected: { label: "Vår 2026", term: "VAR", year: 2026 },
  },
  {
    at: "2026-08-01T00:00:00+02:00",
    expected: { label: "Høst 2026", term: "HOST", year: 2026 },
  },
  {
    at: "2026-10-15T12:00:00+02:00",
    expected: { label: "Høst 2026", term: "HOST", year: 2026 },
  },
  {
    at: "2027-01-01T00:00:00+01:00",
    expected: { label: "Vår 2027", term: "VAR", year: 2027 },
  },
] as const;

describe("C1/C2 semesters through the panel", () => {
  it.effect(
    "RULE-033: the panel's current semester follows the Oslo calendar month, and the read writes no row (spec 0003)",
    () =>
      Effect.gen(function* currentSemesterEffect() {
        for (const { at, expected } of SEMESTER_BY_OSLO_DATE) {
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe(at))
          );

          const tables = makeTables();

          const view = yield* dashboardView.pipe(
            Effect.provide(memoryLayer(tables))
          );

          assert.strictEqual(view.currentSemester, expected.label, at);
          assert.deepStrictEqual(tables.semesters, [], at);
        }
      })
  );
});

// ---------------------------------------------------------------- RULE-130

const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

/**
 * The web upload path's prepare step (`readFile` → `storeOptional`) in the
 * runtime, exactly as `saveArticle`/`saveSponsor` run it. The slot is
 * `imageOrPdf`, the legacy receipt attachment (RULE-130); `/kontakt` has no
 * attachment field yet, so no server function reaches it through the browser.
 */
const uploadThroughWebPath = async (
  file: { readonly bytes: Uint8Array<ArrayBuffer>; readonly name: string },
  actor: Actor
) => {
  const tables = makeTables();
  const layer = Layer.mergeAll(memoryLayer(tables, actor), webCryptoLayer);

  const prepare = Effect.flatMap(
    readFile(form({}, { receipt: file }), "receipt"),
    (upload) => storeOptional(upload, "imageOrPdf")
  );

  const outcome = await runCommandOutcome(
    layer,
    prepare,
    (stored: StoredUpload | null) => Effect.succeed(stored),
    signal
  );

  return { outcome, tables };
};

describe("C11 uploads through the web path", () => {
  it.effect(
    "RULE-130: a .docx is refused with 'Filtypen må være et bilde eller PDF.' and nothing is stored",
    () =>
      Effect.gen(function* docxRefusedEffect() {
        const { outcome, tables } = yield* Effect.promise(
          async () =>
            await uploadThroughWebPath(
              { bytes: DOCX, name: "rekvisitt.docx" },
              TEST_ACTORS.admin
            )
        );

        const error = assertValidationFailure(outcome);

        assert.deepStrictEqual(
          Arr.map(error.issues, (issue) => issue.message),
          ["Filtypen må være et bilde eller PDF."]
        );

        assert.strictEqual(tables.objects.size, 0);
        assert.strictEqual(tables.publicFiles.length, 0);
        assert.strictEqual(tables.commits, 0);
      })
  );

  it.effect(
    "RULE-130: a PNG in the same slot is stored under its content-addressed key",
    () =>
      Effect.gen(function* pngStoredEffect() {
        const { outcome, tables } = yield* Effect.promise(
          async () =>
            await uploadThroughWebPath(
              { bytes: PNG, name: "kvittering.png" },
              TEST_ACTORS.admin
            )
        );

        const stored = Predicate.isTagged(outcome, "Success")
          ? outcome.value.value
          : null;

        assert.strictEqual(stored?.contentType, "image/png");
        assert.strictEqual(stored?.name, "kvittering.png");
        assert.strictEqual(stored?.size, PNG.byteLength);
        assert.match(String(stored?.key), /^[0-9a-f]{64}\.png$/u);
        assert.strictEqual(tables.objects.size, 1);
      })
  );
});

// ---------------------------------------------------------------- RULE-296

const updateStaticContentThroughPanel = (actor: Actor, html: string) =>
  Effect.promise(async () => {
    const tables = makeTables();

    const outcome = await runCommandOutcome(
      memoryLayer(tables, actor),
      Effect.void,
      () =>
        updateStaticContent(
          staticContentInput(form({ editorId: "home-tagline", html }))
        ),
      signal
    );

    return { outcome, tables };
  });

describe("C4 static text through the panel", () => {
  it.effect(
    "RULE-296: a team leader who is not on the executive board gets 403 and nothing is written",
    () =>
      Effect.gen(function* teamLeaderForbiddenEffect() {
        const { outcome, tables } = yield* updateStaticContentThroughPanel(
          TEST_ACTORS.teamLeader,
          "<p>Hei</p>"
        );

        assert.isTrue(Predicate.isTagged(outcome, "Failure"));

        if (Predicate.isTagged(outcome, "Failure")) {
          assert.strictEqual(outcome.status, 403);
          assert.isTrue(Predicate.isTagged(outcome.error, "Forbidden"));
          assert.strictEqual(outcome.message, "Du har ikke tilgang til dette.");
        }

        assert.deepStrictEqual(tables.staticContent, []);
        assert.deepStrictEqual(tables.audit, []);
        assert.strictEqual(tables.commits, 0);
      })
  );

  it.effect(
    "RULE-296: an admin's update replaces the block and is audited",
    () =>
      Effect.gen(function* adminUpdateEffect() {
        const { outcome, tables } = yield* updateStaticContentThroughPanel(
          TEST_ACTORS.admin,
          "<p>Hei</p>"
        );

        assert.deepStrictEqual(
          Predicate.isTagged(outcome, "Success") ? outcome.value.value : null,
          { html: "<p>Hei</p>", key: "home-tagline" }
        );
        assert.deepStrictEqual(tables.staticContent, [
          { html: "<p>Hei</p>", key: "home-tagline" },
        ]);
        assert.deepStrictEqual(
          Arr.map(tables.audit, (entry): readonly string[] => [
            entry.action,
            entry.entityKey,
          ]),
          [["staticContent.updated", "home-tagline"]]
        );
        assert.strictEqual(tables.commits, 1);
      })
  );
});
