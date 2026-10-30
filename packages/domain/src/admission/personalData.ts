/**
 * What the admission domain declares about its stored columns and its form (spec 0009): the application, and the
 * application form's collection of it. The whole application is deleted six months after the end of its admission period
 * (`Periods.applicationAfterPeriodEnd`, proposed), and nothing of it is kept after that: no count, no history row, no copy
 * on the person. The special needs text rests on its own consent, stored beside it (version and time).
 */
import {
  Retention,
  Rules,
  columns,
  erased,
  exported,
  notPersonal,
  ofPerson,
  personal,
  starts,
  table,
} from "../personalData/declaration.ts";
import { collected, form, notCollected } from "../personalData/forms.ts";
import { Periods } from "../personalData/periods.ts";
import { SubmitApplicationInput } from "./entities.ts";

/** An application lives until its period has been over for `Periods.applicationAfterPeriodEnd`. */
const afterPeriodEnd = Retention.make({
  period: Periods.applicationAfterPeriodEnd,
  trigger: starts.periodEnd("period_id"),
});

const assessment = personal({
  legalBasis: "contract",
  onExpiry: Rules.Delete,
  purpose: "admission",
  retention: afterPeriodEnd,
});

const totals = personal({
  legalBasis: "legitimateInterest",
  onExpiry: Rules.Delete,
  purpose: "admission",
  retention: afterPeriodEnd,
});

const specialNeeds = personal({
  legalBasis: "explicitConsent",
  onExpiry: Rules.Delete,
  purpose: "admission",
  retention: afterPeriodEnd,
});

export const AdmissionTables = {
  application: table({
    columns: {
      ...columns(assessment, [
        "available_weekdays",
        "bolk",
        "created_at",
        "double_position",
        "field_of_study_id",
        "period_id",
        "person_id",
        "state",
        "team_interest",
        "year_of_study",
      ]),
      ...columns(totals, ["gender", "heard_about_us"]),
      ...columns(specialNeeds, [
        "special_needs",
        "special_needs_consent_version",
        "special_needs_consented_at",
      ]),
      id: notPersonal(
        "A surrogate key; it names no one on its own, and the row is deleted with the application"
      ),
    },
    person: ofPerson(
      "person_id",
      Rules.Move(
        ["period_id"],
        "Søknaden kan ikke flyttes til den andre personen."
      ),
      exported.rows(),
      erased.expire
    ),
  }),
} as const;

const RECIPIENTS = {
  en: "The recruitment team and the leaders of the department you apply to. No one else sees it, and it is not sent anywhere.",
  no: "Rekrutteringsteamet og lederne i avdelingen du søker til. Ingen andre ser det, og det sendes ikke videre.",
};

const application = {
  legalBasis: "contract",
  purpose: "admission",
  recipients: RECIPIENTS,
} as const;

/** What the application form collects: the one declaration that the notice on the form and the record of processing read. */
export const ApplicationForm = form({
  fields: {
    bolk: collected({
      ...application,
      label: { en: "Your bolk preference", no: "Bolk du foretrekker" },
      storedIn: "application.bolk",
    }),
    departmentId: notCollected(
      "The department you chose to apply to; it is the organisation's, not yours"
    ),
    doublePosition: collected({
      ...application,
      label: {
        en: "Whether you can take a double (8-week) position",
        no: "Om du kan ta dobbel (8 ukers) stilling",
      },
      storedIn: "application.double_position",
    }),
    email: collected({
      ...application,
      label: { en: "Your e-mail address", no: "E-postadressen din" },
      storedIn: "person.email",
    }),
    fieldOfStudyId: collected({
      ...application,
      label: { en: "Your field of study", no: "Linjen din" },
      storedIn: "application.field_of_study_id",
    }),
    gender: collected({
      ...application,
      label: { en: "Your gender (optional)", no: "Kjønn (valgfritt)" },
      legalBasis: "legitimateInterest",
      recipients: {
        en: "Used only in totals. No one reads it for one person.",
        no: "Brukes bare i totaler. Ingen leser det for en enkelt person.",
      },
      storedIn: "application.gender",
    }),
    heardAbout: collected({
      ...application,
      label: {
        en: "Where you heard of us (optional)",
        no: "Hvor du hørte om oss (valgfritt)",
      },
      legalBasis: "legitimateInterest",
      recipients: {
        en: "Used only in totals. No one reads it for one person.",
        no: "Brukes bare i totaler. Ingen leser det for en enkelt person.",
      },
      storedIn: "application.heard_about_us",
    }),
    name: collected({
      ...application,
      label: { en: "Your name", no: "Navnet ditt" },
      storedIn: "person.name",
    }),
    specialNeeds: collected({
      ...application,
      label: {
        en: "Special needs (optional, with your consent)",
        no: "Spesielle behov (valgfritt, med ditt samtykke)",
      },
      legalBasis: "explicitConsent",
      storedIn: "application.special_needs",
    }),
    teamInterest: collected({
      ...application,
      label: {
        en: "Teams you are interested in (optional)",
        no: "Team du er interessert i (valgfritt)",
      },
      storedIn: "application.team_interest",
    }),
    weekdays: collected({
      ...application,
      label: {
        en: "The days that suit you",
        no: "Dagene som passer for deg",
      },
      storedIn: "application.available_weekdays",
    }),
    yearOfStudy: collected({
      ...application,
      label: { en: "Your year of study", no: "Årstrinnet ditt" },
      storedIn: "application.year_of_study",
    }),
  },
  form: "application",
  schema: SubmitApplicationInput,
  title: { en: "Application form", no: "Søknadsskjema" },
});
