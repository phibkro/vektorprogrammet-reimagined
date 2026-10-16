/**
 * `/kontrollpanel` (C1, C2, C4, C5, C6, C8): view programs over the domain's queries and services,
 * the command programs a server function runs, and form → command-input mapping. C1 and C2
 * (departments, semesters, fields of study; spec 0001) are complete; the other capabilities are at stub
 * depth. The domain decodes and validates every input; this module only turns form text into the
 * shapes the domain's input schemas expect (numbers, booleans, nulls, UTC instants). Authorization
 * happens inside each command (in its transaction); the route guard is UX only.
 */
import {
  ArticleRepository,
  Capability,
  CurrentActor,
  DepartmentId,
  DepartmentRepository,
  EVENT_BADGE_LABEL,
  FieldOfStudyId,
  SemesterOrder,
  SocialEventRepository,
  StaticContentKey,
  authorize,
  createDepartment,
  createFieldOfStudy,
  currentSemester,
  decodeInput,
  eventBadge,
  findCurrentSemester,
  getStaticContent,
  listFieldsOfStudy,
  listSemestersNewestFirst,
  listSponsorsForFooter,
  osloWallClock,
  renameFieldOfStudy,
  semesterLabel,
  storeUpload,
  updateDepartment,
} from "@vektorprogrammet/domain";
import type {
  Actor,
  Article,
  Department,
  Semester,
  StoredUpload,
  UploadAccept,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import { actorSummary } from "./shell";

/**
 * Legacy `html_id`s of the editable blocks the old public pages embedded. The public pages now read their text
 * from EmDash (spec 0005), so this list and the page that edits it retire with the content control panel.
 */
const STATIC_BLOCKS = {
  foreldre: ["parent-header", "parent-assistants-info", "parent-course"],
  home: ["home-tagline"],
  kontakt: ["contact-header"],
  nyheter: ["vektor_i_media"],
  omvektor: [
    "about-header",
    "about-motivate-children",
    "about-motivate-students",
    "about-try-teaching",
    "about-faq",
  ],
} as const;

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

export const fieldOfStudyInput = (form: FormData) => {
  const departmentId = optionalText(form, "departmentId");

  const input = {
    name: text(form, "name"),
    shortName: text(form, "shortName"),
  };

  if (departmentId === null) {
    return input;
  }

  return { ...input, departmentId: integer(departmentId) };
};

export const fieldOfStudyRename = (form: FormData) => ({
  name: text(form, "name"),
  shortName: text(form, "shortName"),
});

const decodeDepartmentId = decodeInput(DepartmentId);

const decodeFieldOfStudyId = decodeInput(FieldOfStudyId);

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
      ? createDepartment(input)
      : Effect.flatMap(decodeDepartmentId(Number(id)), (departmentId) =>
          updateDepartment(departmentId, input)
        ),
    SAVED
  );
};

/**
 * C1, RULE-139: a blank `id` creates a field of study (in the named department, by default the
 * actor's own), an `id` renames one. A team leader is refused outside their own department.
 */
export const saveFieldOfStudyProgram = (form: FormData) => {
  const id = text(form, "id");

  return Effect.as(
    id === ""
      ? createFieldOfStudy(fieldOfStudyInput(form))
      : Effect.flatMap(decodeFieldOfStudyId(Number(id)), (fieldOfStudyId) =>
          renameFieldOfStudy(fieldOfStudyId, fieldOfStudyRename(form))
        ),
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
  /** Whether the actor holds `UpdateDepartment` for this department: the page offers the edit form only then. */
  readonly canEdit: boolean;
}

/** Everything the edit form needs, so saving a department never blanks a field it did not show. */
const departmentRow = (
  actor: Actor,
  department: Department
): DepartmentRow => ({
  active: department.active,
  address: department.address,
  canEdit: authorize(
    actor,
    Capability.UpdateDepartment({ departmentId: department.id })
  ),
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

const newestArticleOrder = Order.mapInput(
  Order.Number,
  (article: Article) => -DateTime.toEpochMillis(article.createdAt)
);

/** C2 the current semester (RULE-033, answered by the calendar, no row needed) and who is acting. */
export const dashboardView = Effect.gen(function* dashboardView() {
  const actor = yield* CurrentActor;

  return {
    actor: actorSummary(actor),
    currentSemester: semesterLabel(yield* currentSemester),
  };
});

/** C1 departments (all, including inactive), by name; the create button and each edit form follow the actor's capabilities. */
export const departmentsView = Effect.gen(function* departmentsView() {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;

  return {
    canCreate: authorize(actor, Capability.CreateDepartment()),
    departments: Arr.sort(
      Arr.map(yield* departments.list, (department) =>
        departmentRow(actor, department)
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

/**
 * C1 fields of study of the actor's own department (RULE-139), with its name. An actor who may not manage
 * them (`ManageFieldsOfStudy`) gets no list: `canManage` is false and the page says so.
 */
export const fieldsOfStudyView = Effect.gen(function* fieldsOfStudyView() {
  const actor = yield* CurrentActor;

  if (
    !Predicate.isTagged("Staff")(actor) ||
    !authorize(
      actor,
      Capability.ManageFieldsOfStudy({ departmentId: actor.departmentId })
    )
  ) {
    return { canManage: false as const, department: null, fieldsOfStudy: [] };
  }

  const departments = yield* DepartmentRepository;
  const fields = yield* listFieldsOfStudy(actor.departmentId);

  const department = yield* departments.findById(actor.departmentId).pipe(
    Effect.map((found) => found.name),
    Effect.catchTag("NotFound", () =>
      Effect.succeed(`Avdeling ${actor.departmentId}`)
    )
  );

  return {
    canManage: true as const,
    department: { id: actor.departmentId, name: department },
    fieldsOfStudy: Arr.map(fields, (field) => ({
      id: field.id,
      name: field.name,
      shortName: field.shortName,
    })),
  };
});

// ---------------------------------------------------------------- C4

export const staticContentInput = (form: FormData) => {
  const editorId = optionalText(form, "editorId");
  const input = { html: text(form, "html") };

  if (editorId === null) {
    return input;
  }

  return { ...input, editorId };
};

/** Every block the public pages embed, with its current HTML; `canEdit` is `EditStaticContent` (RULE-296). */
export const staticContentView = Effect.gen(function* staticContentView() {
  const actor = yield* CurrentActor;

  const blocks = yield* Effect.forEach(
    Arr.flatMap(Rec.toEntries(STATIC_BLOCKS), ([page, keys]) =>
      Arr.map(keys, (key) => ({ key, page }))
    ),
    ({ page, key }) =>
      Effect.map(getStaticContent(StaticContentKey.make(key)), (block) => ({
        html: Option.match(block, {
          onNone: () => "",
          onSome: (found): string => found.html,
        }),
        key,
        page,
      }))
  );

  return { blocks, canEdit: authorize(actor, Capability.EditStaticContent()) };
});

// ---------------------------------------------------------------- C5 / C6 uploads

/** A file read from a form before entering Effect. */
export interface UploadedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Reads a form file through its native Promise API; interruption discards the result. */
export const readFile = Effect.fnUntraced(function* readFile(
  form: FormData,
  name: string
) {
  const value = form.get(name);

  if (value === null || Schema.is(Schema.String)(value) || value.size === 0) {
    return null;
  }

  const buffer = yield* Effect.orDie(
    Effect.tryPromise(() => value.arrayBuffer())
  );

  return { bytes: new Uint8Array(buffer), name: value.name };
});

/** Step 1 of an upload (outside the transaction): RULE-130 typing, content-addressed R2 put. */
export const storeOptional = (
  file: UploadedFile | null,
  accept: UploadAccept
) =>
  file === null
    ? Effect.succeed<StoredUpload | null>(null)
    : Effect.map(
        storeUpload({ accept, bytes: file.bytes, name: file.name }),
        (stored): StoredUpload | null => stored
      );

export const articleInput = (
  form: FormData,
  images: {
    readonly large: string | undefined;
    readonly small: string | undefined;
  }
) => {
  const article = {
    body: text(form, "body"),
    departmentIds: Arr.flatMap(form.getAll("departmentIds"), (value) =>
      Schema.is(Schema.String)(value) ? [integer(value)] : []
    ),
    published: checkbox(form, "published"),
    sticky: checkbox(form, "sticky"),
    title: text(form, "title"),
  };

  if (images.large !== undefined) {
    const withLargeImage = { ...article, imageLargeKey: images.large };

    if (images.small !== undefined) {
      return { ...withLargeImage, imageSmallKey: images.small };
    }

    return withLargeImage;
  }

  if (images.small !== undefined) {
    return { ...article, imageSmallKey: images.small };
  }

  return article;
};

/** Published articles, newest first (drafts have no staff listing query yet; see README); `canManage` is `ManageArticles`. */
export const articlesView = Effect.gen(function* articlesView() {
  const actor = yield* CurrentActor;
  const articles = yield* ArticleRepository;
  const published = yield* articles.listPublished;

  return {
    articles: Arr.map(Arr.sort(published, newestArticleOrder), (article) => ({
      id: article.id,
      slug: article.slug,
      sticky: article.sticky,
      title: article.title,
    })),
    canManage: authorize(actor, Capability.ManageArticles()),
  };
});

export const sponsorInput = (form: FormData, logoKey: string | null) => ({
  logoKey,
  name: text(form, "name"),
  size: text(form, "size"),
  url: text(form, "url"),
});

/** Sponsors by size; `canManage` is `ManageSponsors`. */
export const sponsorsView = Effect.gen(function* sponsorsView() {
  const actor = yield* CurrentActor;
  const sponsors = yield* listSponsorsForFooter;

  return {
    canManage: authorize(actor, Capability.ManageSponsors()),
    sponsors: Arr.map(sponsors, (sponsor) => ({
      id: sponsor.id,
      name: sponsor.name,
      size: sponsor.size,
      url: sponsor.url,
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

/**
 * The actor's department's events this semester, with the RULE-085 badge. The events need the current
 * semester's row; until the scheduled job has written it (spec 0003) the page says so
 * (`currentSemesterId` is null) and lists none. A read: it never inserts.
 * The departments the form offers are the ones the actor may create events in (`ManageSocialEvents`);
 * `canCreate` is whether there is one.
 */
export const socialEventsView = Effect.gen(function* socialEventsView() {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;
  const current = yield* findCurrentSemester;
  const currentRow = Option.getOrNull(current.stored);
  const now = yield* DateTime.now;
  const allSemesters = yield* listSemestersNewestFirst;

  const events =
    Predicate.isTagged("Staff")(actor) && currentRow !== null
      ? yield* (yield* SocialEventRepository).list({
          departmentId: actor.departmentId,
          semesterId: currentRow.id,
        })
      : [];

  const creatable = Arr.filter(yield* departments.list, (department) =>
    authorize(
      actor,
      Capability.ManageSocialEvents({ departmentId: department.id })
    )
  );

  return {
    canCreate: creatable.length > 0,
    currentSemesterId: currentRow?.id ?? null,
    currentSemesterLabel: semesterLabel(current.semester),
    departmentId: Predicate.isTagged("Staff")(actor)
      ? actor.departmentId
      : null,
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
