/**
 * Admission (spec 0009): the public application pages' data, the control panel's `/kontrollpanel/opptak` view, and the
 * command programs behind its forms. The domain decodes and validates every input through the command's payload
 * schema (`AdmissionEndpoints.…`) and each command asks the grant table itself; this module reads, turns form text
 * into the shapes the schemas expect (`forms/admission.ts`) and shapes what a page shows. A page's controls ask the same
 * grant table (`authorize`), so a control that the principal may not use is not rendered.
 */
import {
  AdmissionEndpoints,
  AdmissionPeriodRepository,
  ApplicationForm as ApplicationDeclaration,
  ApplicationRepository,
  BOLK_LABEL,
  Catalog,
  CurrentPrincipal,
  DepartmentRepository,
  FieldOfStudyRepository,
  GENDER_LABEL,
  HEARD_ABOUT_LABEL,
  NotFound,
  TeamRepository,
  WEEKDAY_LABEL,
  admissionState,
  authorize,
  currentSemester,
  listSemestersNewestFirst,
  privacyNotice,
  semesterLabel,
  specialNeedsConsentText,
} from "@vektorprogrammet/domain";
import type {
  AdmissionState,
  Department,
  DepartmentId,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
  Record as Rec,
} from "effect";

import {
  CancelPeriodForm,
  ExtendPeriodForm,
  RegisterApplicationForm,
  SchedulePeriodForm,
  WithdrawApplicationForm,
} from "../forms/admission";
import { SAVED } from "./panel";
import { departmentViews } from "./site/pages";

const STATE_LABEL: Readonly<Record<AdmissionState, string>> = {
  Closed: "Avsluttet",
  Open: "Åpent",
  Scheduled: "Planlagt",
};

/** A time as people read it on a page: Oslo wall-clock time. */
const osloTime = (instant: DateTime.Utc): string =>
  DateTime.format(instant, {
    dateStyle: "medium",
    locale: "nb-NO",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });

const byName = (departments: readonly Department[]) =>
  Arr.sort(
    departments,
    Order.mapInput(Order.String, (department: Department) => department.name)
  );

interface Choice {
  readonly label: string;
  readonly value: string;
}

/** What an application form offers a department's applicant: its fields of study and its active teams. */
const choicesOf = Effect.fn("admissionChoices")(function* choicesOf(
  department: Department
) {
  const fields = yield* (yield* FieldOfStudyRepository).listByDepartment(
    department.id
  );

  const teams = yield* (yield* TeamRepository).list(department.id);

  return {
    fieldsOfStudy: Arr.map(fields, (field): Choice => ({
      label: field.name,
      value: String(field.id),
    })),
    teams: Arr.map(
      Arr.filter(teams, (team) => team.active),
      (team): Choice => ({ label: team.name, value: String(team.id) })
    ),
  };
});

/** The closed answers of the form, labelled; every value is the domain's own. */
const labelled = (
  labels: Readonly<Record<string, string>>
): readonly Choice[] =>
  Arr.map(Rec.toEntries(labels), ([value, label]): Choice => ({
    label,
    value,
  }));

const answerChoices = {
  bolk: labelled(BOLK_LABEL),
  gender: labelled(GENDER_LABEL),
  heardAbout: labelled(HEARD_ABOUT_LABEL),
  weekdays: labelled(WEEKDAY_LABEL),
};

// ---------------------------------------------------------------- the public pages

/** `/soknad`: the departments, each with whether its admission is open now (RULE-119). */
export const applyIndexPage = Effect.map(departmentViews, (departments) => ({
  departments,
}));

/** `/soknad/{department}`: the form of one department while its admission is open, and the notice that the form carries. */
export const applicationPage = Effect.fn("applicationPage")(
  function* applicationPage(slug: string, sent: boolean) {
    const found = Arr.findFirst(
      yield* departmentViews,
      (department) => department.slug === slug
    );

    if (Option.isNone(found)) {
      return yield* new NotFound({ entity: "Department", key: slug });
    }

    const departments = yield* (yield* DepartmentRepository).list;

    const department = Arr.findFirst(
      departments,
      (candidate) => candidate.id === found.value.id
    );

    if (Option.isNone(department)) {
      return yield* new NotFound({ entity: "Department", key: slug });
    }

    return {
      choices: answerChoices,
      consent: specialNeedsConsentText.no,
      department: found.value,
      options: yield* choicesOf(department.value),
      privacy: privacyNotice(ApplicationDeclaration, Catalog),
      sent,
    };
  }
);

// ---------------------------------------------------------------- the control panel

/**
 * `/kontrollpanel/opptak`: the admission periods of the departments that the principal may see, and the applications to
 * them, with what the forms need (the semesters to schedule in, the fields of study and teams to register with). A read:
 * it never writes.
 */
export const admissionView = Effect.gen(function* admissionView() {
  const principal = yield* CurrentPrincipal;
  const now = yield* DateTime.now;
  const current = yield* currentSemester;

  const viewable = byName(
    Arr.filter(yield* (yield* DepartmentRepository).list, (department) =>
      authorize(principal, "viewAdmission", { departmentId: department.id })
    )
  );

  const ids = Arr.map(viewable, (department) => department.id);

  const periods = Arr.filter(
    yield* (yield* AdmissionPeriodRepository).listStored,
    (period) => Arr.contains(ids, period.departmentId)
  );

  const applications = yield* (yield* ApplicationRepository).list(ids);

  const nameOf = (departmentId: DepartmentId): string =>
    Option.match(
      Arr.findFirst(viewable, (department) => department.id === departmentId),
      { onNone: () => "", onSome: (department) => department.name }
    );

  const mayIn = (
    command:
      | "createAdmissionPeriod"
      | "extendAdmissionPeriod"
      | "deleteAdmissionPeriod"
      | "registerApplication"
      | "withdrawApplication",
    departmentId: DepartmentId
  ): boolean => authorize(principal, command, { departmentId });

  const schedulable = Arr.filter(viewable, (department) =>
    mayIn("createAdmissionPeriod", department.id)
  );

  const registrable = Arr.filter(
    Arr.filter(periods, (period) =>
      mayIn("registerApplication", period.departmentId)
    ),
    (period) =>
      period.semester.year === current.year &&
      period.semester.term === current.term
  );

  const choices = yield* Effect.forEach(
    Arr.filter(viewable, (department) =>
      Arr.some(registrable, (period) => period.departmentId === department.id)
    ),
    (department) =>
      Effect.map(choicesOf(department), (offered) => ({
        departmentId: department.id,
        ...offered,
      }))
  );

  const registrableIds = Arr.map(registrable, (period) => period.id);
  const semesters = yield* listSemestersNewestFirst;

  return {
    answers: answerChoices,
    applications: Arr.map(applications, (application) => ({
      bolk: BOLK_LABEL[application.bolk],
      canWithdraw:
        Predicate.isTagged(application.state, "Submitted") &&
        mayIn("withdrawApplication", application.departmentId),
      createdAt: osloTime(application.createdAt),
      departmentName: nameOf(application.departmentId),
      doublePosition: application.doublePosition,
      email: application.personEmail,
      emailVerified: application.emailVerified,
      id: application.id,
      name: application.personName,
      periodId: application.periodId,
      specialNeeds: application.specialNeeds?.text ?? null,
      state: application.state._tag,
      weekdays: Arr.map(application.weekdays, (day) => WEEKDAY_LABEL[day]),
      yearOfStudy: application.yearOfStudy,
    })),
    consent: specialNeedsConsentText.no,
    currentSemester: semesterLabel(current),
    periods: Arr.map(periods, (period) => {
      const state = admissionState(period, now);

      return {
        canCancel:
          state === "Scheduled" &&
          mayIn("deleteAdmissionPeriod", period.departmentId),
        canExtend:
          state !== "Closed" &&
          mayIn("extendAdmissionPeriod", period.departmentId),
        departmentId: period.departmentId,
        departmentName: nameOf(period.departmentId),
        end: osloTime(period.end),
        id: period.id,
        register: Arr.contains(registrableIds, period.id)
          ? Option.getOrNull(
              Arr.findFirst(
                choices,
                (offered) => offered.departmentId === period.departmentId
              )
            )
          : null,
        semester: semesterLabel(period.semester),
        start: osloTime(period.start),
        state,
        stateLabel: STATE_LABEL[state],
      };
    }),
    schedulable: Arr.map(schedulable, (department) => ({
      id: department.id,
      name: department.name,
    })),
    semesters: Arr.map(semesters, (semester) => ({
      label: semesterLabel(semester),
      value: `${semester.term}-${semester.year}`,
    })),
  };
});

/** A new admission period (spec 0009). */
export const schedulePeriodProgram = (form: FormData) =>
  Effect.as(
    AdmissionEndpoints.createAdmissionPeriod(SchedulePeriodForm.read(form)),
    SAVED
  );

/** A period gets a later end. */
export const extendPeriodProgram = (form: FormData) =>
  Effect.as(
    AdmissionEndpoints.extendAdmissionPeriod(ExtendPeriodForm.read(form)),
    SAVED
  );

/** A period that has not started is cancelled. */
export const cancelPeriodProgram = (form: FormData) =>
  Effect.as(
    AdmissionEndpoints.deleteAdmissionPeriod(CancelPeriodForm.read(form)),
    SAVED
  );

/** Staff register an applicant at a stand. */
export const registerApplicationProgram = (form: FormData) =>
  Effect.as(
    AdmissionEndpoints.registerApplication(RegisterApplicationForm.read(form)),
    SAVED
  );

/** An application is withdrawn. */
export const withdrawApplicationProgram = (form: FormData) =>
  Effect.as(
    AdmissionEndpoints.withdrawApplication(WithdrawApplicationForm.read(form)),
    SAVED
  );
