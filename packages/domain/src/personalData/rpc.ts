/**
 * The personal data commands as data (spec 0007b, `docs/system/administration.md`): consent, photo, export, erasure,
 * merge, and the two jobs that act as their own principals. Each carries its resource and method (ADR 0010). The
 * grants are rows of the domain's table; `Admin` holds every command that a person may run, as one row.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CodeToken, codeHolder, codePolicy } from "../accounts/code.ts";
import {
  Info,
  grant,
  info,
  leader,
  self,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { FileKey, PersonId } from "../shared/ids.ts";
import { ConsentSummary } from "./consents.ts";
import { durationWords, lifetimeWords } from "./duration.ts";
import { Periods } from "./periods.ts";
import { Counts, PersonExport, RetentionOutcome } from "./services.ts";

const ANSWER_ONE_BOX = "Svar på minst ett av spørsmålene.";

/** The two alumni boxes, each optional: one click answers one. At least one must be answered. */
const AlumniAnswers = {
  keepDetails: Schema.optionalKey(Schema.Boolean),
  news: Schema.optionalKey(Schema.Boolean),
} as const;

const answersOneBox = Schema.makeFilter<{
  readonly keepDetails?: boolean | undefined;
  readonly news?: boolean | undefined;
}>(({ keepDetails, news }) => keepDetails !== undefined || news !== undefined, {
  message: ANSWER_ONE_BOX,
});

export const Hold = Schema.Struct({
  reason: Schema.String,
  source: Schema.String,
  until: Schema.NullOr(Schema.DateTimeUtc),
});

export const ErasureResult = Schema.Struct({
  /** `false` when nothing was left to erase: a second call changes nothing. */
  erased: Schema.Boolean,
  /** Rows that a legal hold keeps, with the date when the hold ends. */
  held: Schema.Array(Hold),
});

export type ErasureResult = typeof ErasureResult.Type;

export const MergeResult = Schema.Struct({
  counts: Counts,
  into: PersonId,
});

export const setPhoto = Rpc.make("setPhoto", {
  error: DomainErrorSchema,
  payload: {
    /** Only the person's own call can give the consent that a photo needs, by setting this. */
    consent: Schema.optionalKey(Schema.Boolean),
    personId: PersonId,
    /** `null` removes the photo and withdraws the photo consent. */
    photo: Schema.NullOr(FileKey),
  },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    method: ":set",
    note: "A photo is stored only under a current photo consent; withdrawing the consent removes it.",
    replaces: ["RULE-142", "RULE-143", "RULE-160"],
    resource: "Person",
    summary: "Set a person's photo under their consent, or remove it.",
  })
);

export const setAlumniConsent = Rpc.make("setAlumniConsent", {
  error: DomainErrorSchema,
  payload: Schema.Struct({ personId: PersonId, ...AlumniAnswers }).check(
    answersOneBox
  ),
  success: ConsentSummary,
}).annotate(
  Info,
  info({
    method: ":set",
    note: "Only the person themself can answer: an administrator's grant does not reach this command, and the handler refuses it, because a consent is the person's own statement.",
    resource: "Consent",
    summary: `Answer the alumni questions on Min side: keep my details for ${durationWords(Periods.personCoreWithKeepDetails.duration, "en")}, and send me alumni news.`,
  })
);

export const answerAlumniConsent = Rpc.make("answerAlumniConsent", {
  error: DomainErrorSchema,
  payload: Schema.Struct({ code: CodeToken, ...AlumniAnswers }).check(
    answersOneBox
  ),
  success: ConsentSummary,
}).annotate(
  Info,
  info({
    credential: "alumniConsent",
    method: ":answer",
    note: `The code lives ${lifetimeWords(codePolicy.alumniConsent.lifetimeSeconds, "en")} and can be used again, so an answer can be corrected; it never opens another command.`,
    resource: "Consent",
    summary: "Answer the alumni questions with the code from the e-mail.",
  })
);

export const exportMyData = Rpc.make("exportMyData", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: PersonExport,
}).annotate(
  Info,
  info({
    method: ":export",
    note: "Audited. It changes no data. Only the person themself can download it: an administrator's grant does not reach this command, and the handler refuses it.",
    resource: "Person",
    summary:
      "Download everything held about a person as JSON (GDPR Art. 15, 20).",
  })
);

export const erasePerson = Rpc.make("erasePerson", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: ErasureResult,
}).annotate(
  Info,
  info({
    method: ":erase",
    note: "Refused, with the reason, while a legal hold applies and when it would remove the last Active admin. A second call changes nothing.",
    replaces: ["RULE-117"],
    resource: "Person",
    summary:
      "Anonymise a person's core fields and delete their account, sessions, consents and subscriptions. The history rows stay (GDPR Art. 17).",
  })
);

export const mergePersons = Rpc.make("mergePersons", {
  error: DomainErrorSchema,
  payload: { from: PersonId, into: PersonId },
  success: MergeResult,
}).annotate(
  Info,
  info({
    method: ":merge",
    note: "Refused with a typed conflict, and nothing changes, when both records have an account or when two memberships in one team would overlap.",
    resource: "Person",
    summary:
      "Merge two records of one person: every row of the second follows the first, and the second becomes a tombstone without personal data.",
  })
);

export const runRetention = Rpc.make("runRetention", {
  error: DomainErrorSchema,
  success: RetentionOutcome,
}).annotate(
  Info,
  info({
    job: "retention",
    method: ":run",
    note: "The audit row holds integer counts per table, never a value. A production run only counts what it would change (audited as `retention.reported`) while any period that it applies is still a proposal; local and preview runs change it (`retention.ran`).",
    resource: "Retention",
    summary:
      "Each night, delete or anonymise what has reached the end of its declared period.",
  })
);

export const sendAlumniConsent = Rpc.make("sendAlumniConsent", {
  error: DomainErrorSchema,
  success: Schema.Struct({ sent: Schema.Int }),
}).annotate(
  Info,
  info({
    job: "alumniConsent",
    method: ":send",
    note: "One request per person and engagement end.",
    resource: "Consent",
    summary:
      "When a person's last engagement ends, e-mail them the two alumni questions once.",
  })
);

export const PersonalDataRpc = RpcGroup.make(
  setPhoto,
  setAlumniConsent,
  answerAlumniConsent,
  exportMyData,
  erasePerson,
  mergePersons,
  runRetention,
  sendAlumniConsent
);

export const PersonalDataDomain = declareDomain({
  commands: PersonalDataRpc,
  grants: [
    grant(
      [self],
      ["setPhoto", "setAlumniConsent", "exportMyData", "erasePerson"],
      "own"
    ),
    grant([leader], ["setPhoto"], "department"),
    grant([codeHolder("alumniConsent")], ["answerAlumniConsent"], "own"),
    grant([system("retention")], ["runRetention"], "all"),
    grant([system("alumniConsent")], ["sendAlumniConsent"], "all"),
  ],
  name: "personalData",
  reads: {},
  title: "Personal data",
});
