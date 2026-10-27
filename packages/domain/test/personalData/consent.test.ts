/**
 * Spec 0007b falsifier 5, the rules half: what a consent record holds after each answer, what the answers read as, when a
 * person has left and for how long the alumni question is still worth asking. The commands and the database that use
 * them are `packages/db/test/personalDataAlumni.postgres.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  answerOf,
  answerRecord,
  consentSummary,
  consentTexts,
  isCurrent,
  leftAt,
  recordOf,
  stillAsked,
} from "../../src/index.ts";
import type { ConsentRecord, StoredConsent } from "../../src/index.ts";
import { PersonId } from "../../src/shared/ids.ts";
import { host, vaar } from "../support/calendar.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const FIRST = at("2026-03-01T10:00:00Z");
const LATER = at("2026-04-02T08:30:00Z");

const stored = (
  kind: StoredConsent["kind"],
  record: ConsentRecord
): StoredConsent => ({ ...record, kind, personId: PersonId.make(1) });

describe("spec 0007b falsifier 5: what an answer records", () => {
  it("a yes is a current record with the version of the text that the person saw and the time", () => {
    const record = answerRecord("news", true, FIRST);

    assert.deepStrictEqual(record, {
      givenAt: FIRST,
      textVersion: consentTexts.news.version,
    });

    assert.isTrue(isCurrent(record));
  });

  it("withdrawing a consent that was given keeps when it was given and the text it was given for, and adds when it ended", () => {
    const given = answerRecord("keepDetails", true, FIRST);
    const withdrawn = answerRecord("keepDetails", false, LATER, given);

    assert.deepStrictEqual(withdrawn, {
      givenAt: FIRST,
      textVersion: given.textVersion,
      withdrawnAt: LATER,
    });

    assert.isFalse(isCurrent(withdrawn));
  });

  it("a no from someone who had not said yes is a record that was given and withdrawn at the same instant", () => {
    const first = answerRecord("news", false, FIRST);

    assert.deepStrictEqual(first, {
      givenAt: FIRST,
      textVersion: consentTexts.news.version,
      withdrawnAt: FIRST,
    });

    // A second no, after the person had already said no, is the same: it records when they were asked again.
    const again = answerRecord("news", false, LATER, first);

    assert.deepStrictEqual(again, {
      givenAt: LATER,
      textVersion: consentTexts.news.version,
      withdrawnAt: LATER,
    });

    assert.isFalse(isCurrent(again));
  });

  it("negative control: a yes after a no is current again, with the time of the new yes", () => {
    const no = answerRecord("news", false, FIRST);
    const yes = answerRecord("news", true, LATER, no);

    assert.isTrue(isCurrent(yes));
    assert.strictEqual(
      DateTime.toEpochMillis(yes.givenAt),
      DateTime.toEpochMillis(LATER)
    );
    assert.isUndefined(yes.withdrawnAt);
  });
});

describe("spec 0007b falsifier 5: what the records read as", () => {
  const records: readonly StoredConsent[] = [
    stored("keepDetails", answerRecord("keepDetails", true, FIRST)),
    stored("news", answerRecord("news", false, FIRST)),
  ];

  it("yes while current, no once withdrawn or refused, and nothing for a question that was never asked", () => {
    assert.deepStrictEqual(consentSummary(records), {
      keepDetails: "yes",
      news: "no",
      photo: null,
    });
  });

  it("finds the record of a kind, and none for another", () => {
    assert.strictEqual(recordOf(records, "news")?.kind, "news");
    assert.isUndefined(recordOf(records, "photo"));
    assert.isNull(answerOf(recordOf([], "news")));
  });
});

describe("spec 0007b falsifier 5: when a person has left", () => {
  const NOW = at("2026-10-27T12:00:00Z");

  it("has left when every membership has ended: at the end of the last one", () => {
    const left = leftAt([{ end: host(2025) }, { end: vaar(2026) }], NOW);

    assert.isTrue(Option.isSome(left));
    // Vår 2026 ends at the end of July, by the Oslo calendar: 2026-07-31T22:00:00Z.
    assert.strictEqual(
      Option.getOrThrow(left).toJSON(),
      "2026-07-31T22:00:00.000Z"
    );
  });

  it("has not left while one membership is current or planned, and has not left with none at all", () => {
    assert.isTrue(Option.isNone(leftAt([], NOW)));
    assert.isTrue(Option.isNone(leftAt([{ end: host(2026) }], NOW)));
    assert.isTrue(
      Option.isNone(leftAt([{ end: vaar(2026) }, { end: vaar(2027) }], NOW))
    );
  });

  it("is asked for one year after the end, which is when the core is anonymised", () => {
    const end = at("2026-07-31T22:00:00Z");

    assert.isTrue(stillAsked(end, at("2027-07-31T21:59:59Z")));
    assert.isFalse(stillAsked(end, at("2027-07-31T22:00:00Z")));
    assert.isFalse(stillAsked(end, at("2028-01-01T00:00:00Z")));
  });
});
