/**
 * `/kontrollpanel` (C1, C2, C4, C5, C6, C8) at stub depth: view programs over
 * the domain's queries and services, and form → command-input mapping. The
 * domain decodes and validates every input; this module only turns form text
 * into the shapes the domain's input schemas expect (numbers, booleans,
 * nulls, UTC instants). Authorization happens inside each command (in its
 * transaction); the route guard is UX only.
 */
import {
  ArticleRepository,
  CurrentActor,
  DepartmentRepository,
  EVENT_BADGE_LABEL,
  SocialEventRepository,
  StaticContentKey,
  ensureCurrentSemester,
  eventBadge,
  getStaticContent,
  listFieldsOfStudy,
  listSemestersNewestFirst,
  listSponsorsForFooter,
  osloWallClock,
  selectableYears,
  semesterLabel,
  storeUpload,
  type StoredUpload,
  type UploadAccept,
} from "@vektorprogrammet/domain";
import { DateTime, Effect, Option } from "effect";
import { STATIC_BLOCKS } from "./pages";

// ---------------------------------------------------------------- form text

/** A form field as text; absent or a file → "". */
export const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Blank → null. */
export const optionalText = (form: FormData, name: string): string | null => {
  const value = text(form, name).trim();
  return value === "" ? null : value;
};

/** A checkbox: present → true. */
export const checkbox = (form: FormData, name: string): boolean => form.has(name);

/** Digits → number; anything else passes through so the domain reports it. */
export const integer = (raw: string): number | string =>
  /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;

/** Optional decimal (latitude/longitude): blank → null. */
const optionalNumber = (form: FormData, name: string): number | string | null => {
  const raw = optionalText(form, name);
  if (raw === null) return null;
  const parsed = Number(raw.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : raw;
};

/**
 * `<input type="datetime-local">` is Oslo wall-clock time; the domain wants a
 * UTC ISO instant. Unparseable input passes through so the domain reports it.
 */
export const osloLocalToIso = (raw: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw);
  if (match === null) return raw;
  const [, year, month, day, hour, minute] = match.map(Number);
  return DateTime.formatIso(osloWallClock({ year, month, day, hour, minute }));
};

// ---------------------------------------------------------------- C1 / C2

export const departmentInput = (form: FormData) => ({
  name: text(form, "name"),
  shortName: text(form, "shortName"),
  email: text(form, "email"),
  city: text(form, "city"),
  address: optionalText(form, "address"),
  active: checkbox(form, "active"),
  slackChannel: optionalText(form, "slackChannel"),
  logoKey: optionalText(form, "logoKey"),
  latitude: optionalNumber(form, "latitude"),
  longitude: optionalNumber(form, "longitude"),
});

export const semesterInput = (form: FormData) => ({
  term: text(form, "term"),
  year: integer(text(form, "year")),
});

export const fieldOfStudyInput = (form: FormData) => {
  const departmentId = optionalText(form, "departmentId");
  return {
    name: text(form, "name"),
    shortName: text(form, "shortName"),
    ...(departmentId === null ? {} : { departmentId: integer(departmentId) }),
  };
};

export const fieldOfStudyRename = (form: FormData) => ({
  name: text(form, "name"),
  shortName: text(form, "shortName"),
});

export interface DepartmentRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  readonly email: string;
  readonly address: string | null;
  readonly active: boolean;
  readonly slackChannel: string | null;
}

/** C1 departments (all, including inactive) and C2 the current semester (RULE-033/237). */
export const dashboardView = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;
  const current = yield* ensureCurrentSemester;
  const rows = (yield* departments.list).map((department): DepartmentRow => ({
    id: department.id,
    name: department.name,
    shortName: department.shortName,
    city: department.city,
    email: department.email,
    address: department.address,
    active: department.active,
    slackChannel: department.slackChannel,
  }));
  return {
    actor:
      actor._tag === "Staff"
        ? {
            role: actor.role,
            departmentId: actor.departmentId,
            executiveBoard: actor.executiveBoard,
          }
        : null,
    currentSemester: semesterLabel(current),
    departments: rows.sort((a, b) => a.name.localeCompare(b.name, "nb")),
  };
});

/** C1 semesters newest first (RULE-084) and the selectable years (RULE-190). */
export const semestersView = Effect.gen(function* () {
  const semesters = yield* listSemestersNewestFirst;
  return {
    semesters: semesters.map((semester) => ({ id: semester.id, label: semesterLabel(semester) })),
    years: selectableYears(yield* DateTime.now),
  };
});

/** C1 fields of study of the actor's own department (RULE-139). */
export const fieldsOfStudyView = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  if (actor._tag !== "Staff") return { departmentId: null, fieldsOfStudy: [] };
  const fields = yield* listFieldsOfStudy(actor.departmentId);
  return {
    departmentId: actor.departmentId,
    fieldsOfStudy: fields.map((field) => ({
      id: field.id,
      name: field.name,
      shortName: field.shortName,
    })),
  };
});

// ---------------------------------------------------------------- C4

export const staticContentInput = (form: FormData) => {
  const editorId = optionalText(form, "editorId");
  return {
    ...(editorId === null ? {} : { editorId }),
    html: text(form, "html"),
  };
};

/** Every block the public pages embed, with its current HTML. */
export const staticContentView = Effect.forEach(
  Object.entries(STATIC_BLOCKS).flatMap(([page, keys]) => keys.map((key) => ({ page, key }))),
  ({ page, key }) =>
    Effect.map(getStaticContent(StaticContentKey.make(key)), (block) => ({
      page,
      key,
      html: Option.match(block, { onNone: () => "", onSome: (found): string => found.html }),
    })),
);

// ---------------------------------------------------------------- C5 / C6 uploads

/** A file read from a form before entering Effect. */
export interface UploadedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Reads a file field; an empty file input → null. Async because `File.arrayBuffer` is. */
export const readFile = (form: FormData, name: string): Promise<UploadedFile | null> => {
  const value = form.get(name);
  if (value === null || typeof value === "string" || value.size === 0) {
    return Promise.resolve(null);
  }
  return value
    .arrayBuffer()
    .then((buffer) => ({ name: value.name, bytes: new Uint8Array(buffer) }));
};

/** Step 1 of an upload (outside the transaction): RULE-130 typing, content-addressed R2 put. */
export const storeOptional = (file: UploadedFile | null, accept: UploadAccept) =>
  file === null
    ? Effect.succeed<StoredUpload | null>(null)
    : Effect.map(
        storeUpload({ name: file.name, bytes: file.bytes, accept }),
        (stored): StoredUpload | null => stored,
      );

export const articleInput = (
  form: FormData,
  images: { readonly small: string | undefined; readonly large: string | undefined },
) => ({
  title: text(form, "title"),
  body: text(form, "body"),
  ...(images.small === undefined ? {} : { imageSmallKey: images.small }),
  ...(images.large === undefined ? {} : { imageLargeKey: images.large }),
  sticky: checkbox(form, "sticky"),
  published: checkbox(form, "published"),
  departmentIds: form
    .getAll("departmentIds")
    .flatMap((value) => (typeof value === "string" ? [integer(value)] : [])),
});

/** Published articles, newest first (drafts have no staff listing query yet; see README). */
export const articlesView = Effect.gen(function* () {
  const articles = yield* ArticleRepository;
  const published = yield* articles.listPublished;
  return [...published]
    .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))
    .map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      sticky: article.sticky,
    }));
});

export const sponsorInput = (form: FormData, logoKey: string | null) => ({
  name: text(form, "name"),
  url: text(form, "url"),
  size: text(form, "size"),
  logoKey,
});

export const sponsorsView = Effect.map(listSponsorsForFooter, (sponsors) =>
  sponsors.map((sponsor) => ({
    id: sponsor.id,
    name: sponsor.name,
    url: sponsor.url,
    size: sponsor.size,
  })),
);

// ---------------------------------------------------------------- C8

export const socialEventInput = (form: FormData) => ({
  title: text(form, "title"),
  description: text(form, "description"),
  startsAt: osloLocalToIso(text(form, "startsAt")),
  endsAt: osloLocalToIso(text(form, "endsAt")),
  link: optionalText(form, "link"),
  departmentId: integer(text(form, "departmentId")),
  semesterId: integer(text(form, "semesterId")),
});

/** The actor's department's events this semester, with the RULE-085 badge. */
export const socialEventsView = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;
  const current = yield* ensureCurrentSemester;
  const now = yield* DateTime.now;
  const allSemesters = yield* listSemestersNewestFirst;
  const events =
    actor._tag === "Staff"
      ? yield* (yield* SocialEventRepository).list({
          departmentId: actor.departmentId,
          semesterId: current.id,
        })
      : [];
  return {
    departmentId: actor._tag === "Staff" ? actor.departmentId : null,
    currentSemesterId: current.id,
    semesters: allSemesters.map((semester) => ({
      id: semester.id,
      label: semesterLabel(semester),
    })),
    departments: (yield* departments.list).map((department) => ({
      id: department.id,
      name: department.name,
    })),
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: DateTime.formatIso(event.startsAt),
      badge: EVENT_BADGE_LABEL[eventBadge(event, now)],
    })),
  };
});
