import {
  Admission,
  HeardAbout,
  PersonalDataRpcs,
  Weekday,
} from "@vektorprogrammet/domain";
import { Array as Arr, Record as Rec, Result, Schema } from "effect";

import {
  Text,
  blankToNull,
  formSchema,
  isChecked,
  osloLocalToIso,
  wholeNumber,
} from "./formSchema";
import type { FormText } from "./formSchema";
import { semesterOfChoice } from "./semester";

/** The value names that the application's checkboxes hold: one per option, `weekday-Monday`, `source-Web`, `team-12`. */
export const WEEKDAY_PREFIX = "weekday-";

export const SOURCE_PREFIX = "source-";

export const TEAM_PREFIX = "team-";

/** The name of the consent to store special needs, and of its text: the paths of the domain's issues on them. */
export const SPECIAL_NEEDS_CONSENT = "specialNeeds.consent";

export const SPECIAL_NEEDS_TEXT = "specialNeeds.text";

/** Every name is free text or nothing: a checkbox has a name of its own, so the form's names are not a fixed list. */
const AnyText = Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String));

const checkedOf = <Option extends string>(
  text: FormText,
  prefix: string,
  options: readonly Option[]
): readonly Option[] =>
  Arr.filter(options, (option) => isChecked(text[`${prefix}${option}`]));

const checkedTeams = (text: FormText): readonly number[] =>
  Arr.filterMap(
    Arr.filter(
      Rec.keys(text),
      (name) => name.startsWith(TEAM_PREFIX) && isChecked(text[name])
    ),
    (name) => {
      const id = wholeNumber(name.slice(TEAM_PREFIX.length));

      return Number.isNaN(id) ? Result.failVoid : Result.succeed(id);
    }
  );

/**
 * The applicant's own answers, the same for a public submit and for a staff registration (one input schema, so the two
 * cannot check different things). The special needs are `null` unless the person typed something or ticked the consent;
 * a text without the consent reaches the domain as it is, and the domain's message says that it needs the consent.
 */
const applicantOf = (text: FormText) => {
  const wantsSpecialNeeds =
    isChecked(text[SPECIAL_NEEDS_CONSENT]) ||
    blankToNull(text[SPECIAL_NEEDS_TEXT]) !== null;

  return {
    bolk: text.bolk ?? "",
    doublePosition: isChecked(text.doublePosition),
    email: text.email ?? "",
    fieldOfStudyId: wholeNumber(text.fieldOfStudyId),
    gender: blankToNull(text.gender),
    heardAbout: checkedOf(text, SOURCE_PREFIX, HeardAbout.literals),
    name: text.name ?? "",
    specialNeeds: wantsSpecialNeeds
      ? {
          consent: isChecked(text[SPECIAL_NEEDS_CONSENT]),
          text: text[SPECIAL_NEEDS_TEXT] ?? "",
        }
      : null,
    teamInterest: checkedTeams(text),
    weekdays: checkedOf(text, WEEKDAY_PREFIX, Weekday.literals),
    yearOfStudy: wholeNumber(text.yearOfStudy),
  };
};

/** The public application form of one department. */
export const ApplicationForm = formSchema(
  AnyText,
  Admission.submitApplication.payloadSchema,
  (text) => ({
    ...applicantOf(text),
    departmentId: wholeNumber(text.departmentId),
  })
);

/** Staff register an applicant at a stand, in a period. */
export const RegisterApplicationForm = formSchema(
  AnyText,
  Admission.registerApplication.payloadSchema,
  (text) => ({ ...applicantOf(text), periodId: wholeNumber(text.periodId) })
);

/** A new admission period: a department, a semester and the window (Oslo wall-clock time). */
export const SchedulePeriodForm = formSchema(
  Schema.Struct({ departmentId: Text, end: Text, semester: Text, start: Text }),
  Admission.createAdmissionPeriod.payloadSchema,
  (text) => ({
    departmentId: wholeNumber(text.departmentId),
    end: osloLocalToIso(text.end),
    semester: semesterOfChoice(text.semester),
    start: osloLocalToIso(text.start),
  })
);

/** A period gets a later end. */
export const ExtendPeriodForm = formSchema(
  Schema.Struct({ end: Text, id: Text }),
  Admission.extendAdmissionPeriod.payloadSchema,
  (text) => ({ end: osloLocalToIso(text.end), id: wholeNumber(text.id) })
);

/** A period that has not started is cancelled. */
export const CancelPeriodForm = formSchema(
  Schema.Struct({ id: Text }),
  Admission.deleteAdmissionPeriod.payloadSchema,
  (text) => ({ id: wholeNumber(text.id) })
);

/** An application is withdrawn. */
export const WithdrawApplicationForm = formSchema(
  Schema.Struct({ id: Text }),
  Admission.withdrawApplication.payloadSchema,
  (text) => ({ id: wholeNumber(text.id) })
);

/** The button of the verification link: the code of the mail, posted as it came. */
export const VerifyApplicantForm = formSchema(
  Schema.Struct({ kode: Text }),
  PersonalDataRpcs.verifyApplicantEmail.payloadSchema,
  (text) => ({ code: text.kode ?? "" })
);
