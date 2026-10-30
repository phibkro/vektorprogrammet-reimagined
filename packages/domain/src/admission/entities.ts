/**
 * The entities of the admission domain (spec 0009, `docs/system/admission.md` § Entities): the input that an applicant
 * or a staff member gives, the application with the state it is in, and the closed value sets of its fields. One input
 * schema serves the public form and the staff registration, so the two cannot check different things.
 */
import { Schema } from "effect";

import {
  AdmissionPeriodId,
  ApplicationId,
  DepartmentId,
  FieldOfStudyId,
  PersonId,
  TeamId,
} from "../shared/ids.ts";
import {
  EmailAddressInput,
  REQUIRED_FIELD_MESSAGE,
  requiredText,
} from "../shared/validation.ts";

/** RULE-027: the days that suit the applicant, not the days that do not. */
export const Weekday = Schema.Literals([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
]);

export type Weekday = typeof Weekday.Type;

export const WEEKDAY_LABEL: Readonly<Record<Weekday, string>> = {
  Friday: "Fredag",
  Monday: "Mandag",
  Thursday: "Torsdag",
  Tuesday: "Tirsdag",
  Wednesday: "Onsdag",
};

/** Which half of the semester the applicant prefers (RULE-013): the first, the second, or either. */
export const Bolk = Schema.Literals(["Bolk1", "Bolk2", "Both"]);

export type Bolk = typeof Bolk.Type;

export const BOLK_LABEL: Readonly<Record<Bolk, string>> = {
  Bolk1: "Bolk 1",
  Bolk2: "Bolk 2",
  Both: "Begge",
};

export const Gender = Schema.Literals(["Female", "Male", "Other"]);

export type Gender = typeof Gender.Type;

export const GENDER_LABEL: Readonly<Record<Gender, string>> = {
  Female: "Kvinne",
  Male: "Mann",
  Other: "Annet",
};

/** Where the applicant heard of the programme: the answers that the legacy form offered. */
export const HeardAbout = Schema.Literals([
  "Blesting",
  "Stand",
  "Web",
  "Acquaintances",
  "Board",
  "Posters",
  "StudentUnion",
]);

export type HeardAbout = typeof HeardAbout.Type;

export const HEARD_ABOUT_LABEL: Readonly<Record<HeardAbout, string>> = {
  Acquaintances: "Bekjente",
  Blesting: "Blesting",
  Board: "Bekjente i styret",
  Posters: "Plakater og flyers",
  Stand: "Stand",
  StudentUnion: "Linjeforeningen (for eksempel fadderukene)",
  Web: "Infomail, nettsida, Facebook og liknende",
};

/** Where an application is. Spec 0010 adds Accepted and NotAccepted, spec 0011 Placed. */
export const ApplicationState = Schema.TaggedUnion({
  Submitted: {},
  Withdrawn: {},
});

export type ApplicationState = typeof ApplicationState.Type;

/** What the applicant is asked for special needs: the text, and that they said yes to storing it (Art. 9(2)(a)). */
export const SPECIAL_NEEDS_CONSENT_REQUIRED =
  "Spesielle behov lagres bare hvis du samtykker til det.";

export const SpecialNeedsInput = Schema.Struct({
  consent: Schema.Literal(true).annotate({
    message: SPECIAL_NEEDS_CONSENT_REQUIRED,
  }),
  text: requiredText({ maxLength: 1000 }),
});

/** The text of the consent that the form shows, and the version that a stored text names (spec 0009, proposed). */
export const specialNeedsConsentText = {
  approval: "proposed",
  en: "Yes, Vektorprogrammet may store what I write about special needs, to make adjustments for me. It is deleted with my application. I can withdraw this at any time.",
  no: "Ja, Vektorprogrammet kan lagre det jeg skriver om spesielle behov, for å tilpasse opplegget for meg. Det slettes sammen med søknaden min. Jeg kan trekke samtykket når som helst.",
  version: 1,
} as const;

const ONE_WEEKDAY = "Velg minst én dag.";

const YEAR_OF_STUDY = "Velg årstrinn fra 1 til 5.";

/**
 * What an applicant gives, whether they type it themselves or staff register it for them (RULE-105, 129, 138): the
 * same fields and the same checks. That the field of study belongs to the department and that each team is an active
 * team of it need the store, so the command checks them (RULE-159, 165).
 */
export const ApplicantInput = Schema.Struct({
  bolk: Bolk.annotate({ message: "Velg bolk." }),
  doublePosition: Schema.Boolean,
  email: EmailAddressInput.annotateKey({
    messageMissingKey: REQUIRED_FIELD_MESSAGE,
  }),
  fieldOfStudyId: FieldOfStudyId.annotate({
    message: "Velg linje.",
  }).annotateKey({ messageMissingKey: "Velg linje." }),
  gender: Schema.NullOr(Gender),
  heardAbout: Schema.Array(HeardAbout).check(
    Schema.isUnique({ message: "Hver kilde kan bare velges én gang." })
  ),
  name: requiredText({ maxLength: 255 }).annotateKey({
    messageMissingKey: REQUIRED_FIELD_MESSAGE,
  }),
  specialNeeds: Schema.NullOr(SpecialNeedsInput),
  teamInterest: Schema.Array(TeamId).check(
    Schema.isUnique({ message: "Hvert team kan bare velges én gang." })
  ),
  weekdays: Schema.Array(Weekday).check(
    Schema.isMinLength(1, { message: ONE_WEEKDAY }),
    Schema.isUnique({ message: "Hver dag kan bare velges én gang." })
  ),
  yearOfStudy: Schema.Int.check(
    Schema.isBetween({ maximum: 5, minimum: 1 }, { message: YEAR_OF_STUDY })
  ).annotate({ message: YEAR_OF_STUDY }),
});

export type ApplicantInput = typeof ApplicantInput.Type;

export const SubmitApplicationInput = Schema.Struct({
  ...ApplicantInput.fields,
  departmentId: DepartmentId.annotate({
    message: "Velg avdeling.",
  }).annotateKey({ messageMissingKey: "Velg avdeling." }),
});

export const RegisterApplicationInput = Schema.Struct({
  ...ApplicantInput.fields,
  periodId: AdmissionPeriodId.annotate({
    message: "Velg opptak.",
  }).annotateKey({ messageMissingKey: "Velg opptak." }),
});

/** A stored application. The special needs text is present only with the consent that it was stored under. */
export const Application = Schema.Struct({
  bolk: Bolk,
  createdAt: Schema.DateTimeUtc,
  doublePosition: Schema.Boolean,
  fieldOfStudyId: FieldOfStudyId,
  gender: Schema.NullOr(Gender),
  heardAbout: Schema.Array(HeardAbout),
  id: ApplicationId,
  periodId: AdmissionPeriodId,
  personId: PersonId,
  specialNeeds: Schema.NullOr(
    Schema.Struct({
      consentVersion: Schema.Int,
      consentedAt: Schema.DateTimeUtc,
      text: Schema.String,
    })
  ),
  state: ApplicationState,
  teamInterest: Schema.Array(TeamId),
  weekdays: Schema.Array(Weekday),
  yearOfStudy: Schema.Int,
});

export type Application = typeof Application.Type;
