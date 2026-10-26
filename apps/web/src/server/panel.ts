/**
 * `/kontrollpanel` (C1, C2, C8): view programs over the domain's queries and services, the command programs a
 * server function runs, and form → command-input mapping. The domain decodes and validates every input (through the
 * command's own payload schema: `OrganisationEndpoints.…`); this module only turns form text into the shapes the
 * domain's input schemas expect (numbers, booleans, nulls, UTC instants). Authorization happens inside each command
 * (in its transaction); a page's controls ask the same grant table (`authorize`), so a control the principal may not
 * use is not rendered. The public site's content (texts, news, sponsors, FAQ, teams) is edited in the CMS
 * (spec 0005), not here.
 */
import {
  ContentEndpoints,
  CurrentPrincipal,
  DepartmentRepository,
  EVENT_BADGE_LABEL,
  Organisation,
  OrganisationEndpoints,
  SemesterOrder,
  SocialEventRepository,
  authorize,
  currentSemester,
  eventBadge,
  findCurrentSemester,
  listFieldsOfStudy,
  listSemestersNewestFirst,
  osloWallClock,
  semesterLabel,
} from "@vektorprogrammet/domain";
import type { Department, Principal, Semester } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option, Order, Schema } from "effect";

import { actorSummary, nameOfActor } from "./shell";

// ---------------------------------------------------------------- form text

/** A form field as text; absent or a file → "". */
export const text = (form: FormData, name: string): string => {
  const value = form.get(name);

  return Schema.is(Schema.String)(value) ? value : "";
};

/** Blank → null. */
export const optionalText = (form: FormData, name: string): string | null => {
  const value = text(form, name).trim();

  return value === "" ? null : value;
};

/** A checkbox: present → true. */
export const checkbox = (form: FormData, name: string): boolean =>
  form.has(name);

/** Digits → number; anything else passes through so the domain reports it. */
export const integer = (raw: string): number | string =>
  /^-?\d+$/u.test(raw.trim()) ? Number(raw) : raw;

/** Optional decimal (latitude/longitude): blank → null. */
const optionalNumber = (
  form: FormData,
  name: string
): number | string | null => {
  const raw = optionalText(form, name);

  if (raw === null) {
    return null;
  }

  const parsed = Number(raw.replace(",", "."));

  return Number.isFinite(parsed) ? parsed : raw;
};

/**
 * `<input type="datetime-local">` is Oslo wall-clock time; the domain wants a
 * UTC ISO instant. Unparseable input passes through so the domain reports it.
 */
export const osloLocalToIso = (raw: string): string => {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/u.exec(
      raw
    );

  if (match === null) {
    return raw;
  }

  const [, year, month, day, hour, minute] = Arr.map(match, Number);

  return DateTime.formatIso(osloWallClock({ day, hour, minute, month, year }));
};

// ---------------------------------------------------------------- C1 / C2

/** What every successful panel command answers with. */
export const SAVED = "Lagret.";

export const departmentInput = (form: FormData) => ({
  active: checkbox(form, "active"),
  address: optionalText(form, "address"),
  city: text(form, "city"),
  email: text(form, "email"),
  latitude: optionalNumber(form, "latitude"),
  logoKey: optionalText(form, "logoKey"),
  longitude: optionalNumber(form, "longitude"),
  name: text(form, "name"),
  shortName: text(form, "shortName"),
  slackChannel: optionalText(form, "slackChannel"),
});

export const fieldOfStudyInput = (form: FormData) => ({
  departmentId: integer(text(form, "departmentId")),
  name: text(form, "name"),
  shortName: text(form, "shortName"),
});

export const fieldOfStudyRename = (form: FormData) => ({
  name: text(form, "name"),
  shortName: text(form, "shortName"),
});

/**
 * C1: a blank `id` creates a department, an `id` updates it. The commands authorize inside their
 * transaction (an admin creates; an admin or the department's team leader updates), and a repeated
 * city is refused by the unique constraint.
 */
export const saveDepartmentProgram = (form: FormData) => {
  const id = text(form, "id");
  const input = departmentInput(form);

  return Effect.as(
    id === ""
      ? OrganisationEndpoints.createDepartment(input)
      : OrganisationEndpoints.updateDepartment({ id: integer(id), ...input }),
    SAVED
  );
};

/**
 * C1, RULE-139: a blank `id` creates a field of study (in the named department), an `id` renames one. A team
 * leader is refused outside their own department.
 */
export const saveFieldOfStudyProgram = (form: FormData) => {
  const id = text(form, "id");

  return Effect.as(
    id === ""
      ? OrganisationEndpoints.createFieldOfStudy(fieldOfStudyInput(form))
      : OrganisationEndpoints.renameFieldOfStudy({
          id: integer(id),
          ...fieldOfStudyRename(form),
        }),
    SAVED
  );
};

export interface DepartmentRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  readonly email: string;
  readonly address: string | null;
  readonly active: boolean;
  readonly slackChannel: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly logoKey: string | null;
  /** Whether the principal holds `updateDepartment` for this department: the page offers the edit form only then. */
  readonly canEdit: boolean;
}

/** Everything the edit form needs, so saving a department never blanks a field it did not show. */
const departmentRow = (
  principal: Principal,
  department: Department
): DepartmentRow => ({
  active: department.active,
  address: department.address,
  canEdit: authorize(principal, "updateDepartment", {
    departmentId: department.id,
  }),
  city: department.city,
  email: department.email,
  id: department.id,
  latitude: department.latitude,
  logoKey: department.logoKey,
  longitude: department.longitude,
  name: department.name,
  shortName: department.shortName,
  slackChannel: department.slackChannel,
});

const byDepartmentName = Order.mapInput(
  Order.make((left: string, right: string): -1 | 0 | 1 => {
    const comparison = left.localeCompare(right, "nb");

    if (comparison < 0) {
      return -1;
    }

    if (comparison > 0) {
      return 1;
    }

    return 0;
  }),
  (row: DepartmentRow) => row.name
);

/** C2 the current semester (RULE-033, answered by the calendar, no row needed) and who is acting. */
export const dashboardView = Effect.gen(function* dashboardView() {
  yield* Organisation.OrganisationDomain.requireGrant("openControlPanel", {});
  const principal = yield* CurrentPrincipal;

  return {
    actor: actorSummary(principal, yield* nameOfActor),
    currentSemester: semesterLabel(yield* currentSemester),
  };
});

/** C1 departments (all, including inactive), by name; the create button and each edit form follow the grant table. */
export const departmentsView = Effect.gen(function* departmentsView() {
  const principal = yield* CurrentPrincipal;
  const departments = yield* DepartmentRepository;

  return {
    canCreate: authorize(principal, "createDepartment"),
    departments: Arr.sort(
      Arr.map(yield* departments.list, (department) =>
        departmentRow(principal, department)
      ),
      byDepartmentName
    ),
  };
});

/**
 * C1 semesters newest first (RULE-084) with the current one marked (RULE-033). The scheduled job
 * writes them (spec 0003, RULE-237); this read never does. While the current semester has no row
 * yet, `current.stored` is false and the page says so.
 */
export const semestersView = Effect.gen(function* semestersView() {
  yield* Organisation.OrganisationDomain.requireGrant("openControlPanel", {});
  const current = yield* currentSemester;
  const semesters = yield* listSemestersNewestFirst;

  const isCurrent = (semester: Semester) =>
    SemesterOrder(semester, current) === 0;

  return {
    current: {
      label: semesterLabel(current),
      stored: Arr.some(semesters, isCurrent),
    },
    semesters: Arr.map(semesters, (semester) => ({
      current: isCurrent(semester),
      id: semester.id,
      label: semesterLabel(semester),
    })),
  };
});

const byId = Order.mapInput(
  Order.Number,
  (row: { readonly id: number }) => row.id
);

/** The departments of the principal that may use `command`, by id: the ones its memberships are in, or every one for an admin. */
const departmentsFor = Effect.fnUntraced(function* departmentsFor(
  command: "createFieldOfStudy" | "createSocialEvent"
) {
  const principal = yield* CurrentPrincipal;
  const departments = yield* DepartmentRepository;

  return Arr.sort(
    Arr.filter(yield* departments.list, (department) =>
      authorize(principal, command, { departmentId: department.id })
    ),
    byId
  );
});

/**
 * C1 fields of study (RULE-139) of the first department the principal may manage them in, with its name. A
 * principal who may manage none gets no list: `canManage` is false and the page says so.
 */
export const fieldsOfStudyView = Effect.gen(function* fieldsOfStudyView() {
  const [department] = yield* departmentsFor("createFieldOfStudy");

  if (department === undefined) {
    return { canManage: false as const, department: null, fieldsOfStudy: [] };
  }

  const fields = yield* listFieldsOfStudy(department.id);

  return {
    canManage: true as const,
    department: { id: department.id, name: department.name },
    fieldsOfStudy: Arr.map(fields, (field) => ({
      id: field.id,
      name: field.name,
      shortName: field.shortName,
    })),
  };
});

// ---------------------------------------------------------------- C8

export const socialEventInput = (form: FormData) => ({
  departmentId: integer(text(form, "departmentId")),
  description: text(form, "description"),
  endsAt: osloLocalToIso(text(form, "endsAt")),
  link: optionalText(form, "link"),
  semesterId: integer(text(form, "semesterId")),
  startsAt: osloLocalToIso(text(form, "startsAt")),
  title: text(form, "title"),
});

/** C8: one social event. */
export const saveSocialEventProgram = (form: FormData) =>
  Effect.as(ContentEndpoints.createSocialEvent(socialEventInput(form)), SAVED);

/**
 * The events this semester of the first department the principal may create them in, with the RULE-085 badge.
 * The events need the current semester's row; until the scheduled job has written it (spec 0003) the page says so
 * (`currentSemesterId` is null) and lists none. A read: it never inserts. The departments the form offers are the
 * ones the principal may create events in (`createSocialEvent`); `canCreate` is whether there is one.
 */
export const socialEventsView = Effect.gen(function* socialEventsView() {
  const creatable = yield* departmentsFor("createSocialEvent");
  const [first] = creatable;
  const current = yield* findCurrentSemester;
  const currentRow = Option.getOrNull(current.stored);
  const now = yield* DateTime.now;
  const allSemesters = yield* listSemestersNewestFirst;

  const events =
    first !== undefined && currentRow !== null
      ? yield* (yield* SocialEventRepository).list({
          departmentId: first.id,
          semesterId: currentRow.id,
        })
      : [];

  return {
    canCreate: creatable.length > 0,
    currentSemesterId: currentRow?.id ?? null,
    currentSemesterLabel: semesterLabel(current.semester),
    departmentId: first?.id ?? null,
    departments: Arr.map(creatable, (department) => ({
      id: department.id,
      name: department.name,
    })),
    events: Arr.map(events, (event) => ({
      badge: EVENT_BADGE_LABEL[eventBadge(event, now)],
      id: event.id,
      startsAt: DateTime.formatIso(event.startsAt),
      title: event.title,
    })),
    semesters: Arr.map(allSemesters, (semester) => ({
      id: semester.id,
      label: semesterLabel(semester),
    })),
  };
});
