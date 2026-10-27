/**
 * Consent records and the request that asks for them (spec 0007b). A consent is the value `ConsentRecord`: the version
 * of the text the person saw, when they gave it and when they withdrew it. Every consent of every spec (alumni news,
 * keeping the details, a photo; later alerts and special needs) is one of these, one record per person and kind. A "no"
 * is a record that was given and withdrawn at the same instant: the person was asked, which text they saw and when.
 */
import { Array as Arr, Option, Schema } from "effect";
import type { DateTime } from "effect";

import { PersonId } from "../shared/ids.ts";
import {
  Rules,
  columns,
  ofPerson,
  personal,
  table,
  ConsentKind,
} from "./declaration.ts";
import { withThePersonCore } from "./retentions.ts";
import { consentTexts } from "./texts.ts";

export const ConsentRecord = Schema.Struct({
  givenAt: Schema.DateTimeUtc,
  textVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  withdrawnAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type ConsentRecord = typeof ConsentRecord.Type;

/** A stored record: the person and the kind it is about. */
export const StoredConsent = Schema.Struct({
  ...ConsentRecord.fields,
  kind: ConsentKind,
  personId: PersonId,
});

export type StoredConsent = typeof StoredConsent.Type;

/** A record is current while it is given and not withdrawn. A "no" is never current. */
export const isCurrent = (record: ConsentRecord): boolean =>
  record.withdrawnAt === undefined;

/** The record of one kind among a person's records, if there is one. */
export const recordOf = (
  records: readonly StoredConsent[],
  kind: ConsentKind
): StoredConsent | undefined =>
  Arr.findFirst(records, (record) => record.kind === kind).pipe(
    Option.getOrUndefined
  );

/** What a person has answered to a consent question: yes, no, or nothing yet. */
export const Answer = Schema.NullOr(Schema.Literals(["yes", "no"]));

export type Answer = typeof Answer.Type;

/** The current answers of the alumni boxes and the photo, as Min side and the answer page show them. */
export const ConsentSummary = Schema.Struct({
  keepDetails: Answer,
  news: Answer,
  photo: Answer,
});

export type ConsentSummary = typeof ConsentSummary.Type;

export const answerOf = (record: StoredConsent | undefined): Answer => {
  if (record === undefined) {
    return null;
  }

  return isCurrent(record) ? "yes" : "no";
};

/** The answers that the records hold now: yes, no, or nothing yet. */
export const consentSummary = (
  records: readonly StoredConsent[]
): ConsentSummary => ({
  keepDetails: answerOf(recordOf(records, "keepDetails")),
  news: answerOf(recordOf(records, "news")),
  photo: answerOf(recordOf(records, "photo")),
});

/**
 * The record that an answer makes now. A yes is current. A withdrawal keeps the consent that was given, with the version
 * of the text the person saw and when, and adds when they withdrew it. A no from someone who had not said yes is a record
 * that was given and withdrawn at the same instant: the person was asked, which text they saw and when.
 */
export const answerRecord = (
  kind: ConsentKind,
  given: boolean,
  at: DateTime.Utc,
  previous?: ConsentRecord
): ConsentRecord => {
  const record: ConsentRecord = {
    givenAt: at,
    textVersion: consentTexts[kind].version,
  };

  if (given) {
    return record;
  }

  return previous !== undefined && isCurrent(previous)
    ? {
        givenAt: previous.givenAt,
        textVersion: previous.textVersion,
        withdrawnAt: at,
      }
    : { ...record, withdrawnAt: at };
};

/** The two boxes of the alumni question. */
export const AlumniBox = Schema.Literals(["keepDetails", "news"]);

export type AlumniBox = typeof AlumniBox.Type;

const consent = table({
  columns: columns(
    personal({
      legalBasis: "legalObligation",
      onExpiry: Rules.Delete,
      purpose: "consents",
      retention: withThePersonCore,
    }),
    [
      "decided_at",
      "given_at",
      "kind",
      "person_id",
      "text_version",
      "withdrawn_at",
    ]
  ),
  person: ofPerson("person_id", Rules.Newest("kind", "decided_at")),
});

/** One request per person and engagement end: the row is what makes the alumni e-mail go out once. */
const alumniRequest = table({
  columns: columns(
    personal({
      legalBasis: "legitimateInterest",
      onExpiry: Rules.Delete,
      purpose: "alumni",
      retention: withThePersonCore,
    }),
    ["engagement_end", "person_id", "requested_at"]
  ),
  person: ofPerson("person_id", Rules.Move(["engagement_end"])),
});

export const ConsentTables = {
  alumni_request: alumniRequest,
  consent,
} as const;
