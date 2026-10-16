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
} from "@vektorprogrammet/domain";
import type {
  Article,
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

import { STATIC_BLOCKS } from "./pages";

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

export const semesterInput = (form: FormData) => ({
  term: text(form, "term"),
  year: integer(text(form, "year")),
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

/** C1 departments (all, including inactive) and C2 the current semester (RULE-033/237). */
export const dashboardView = Effect.gen(function* dashboardView() {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;
  const current = yield* ensureCurrentSemester;

  const rows = Arr.map(
    yield* departments.list,
    (department): DepartmentRow => ({
      active: department.active,
      address: department.address,
      city: department.city,
      email: department.email,
      id: department.id,
      name: department.name,
      shortName: department.shortName,
      slackChannel: department.slackChannel,
    })
  );

  return {
    actor: Predicate.isTagged("Staff")(actor)
      ? {
          departmentId: actor.departmentId,
          executiveBoard: actor.executiveBoard,
          role: actor.role,
        }
      : null,
    currentSemester: semesterLabel(current),
    departments: Arr.sort(rows, byDepartmentName),
  };
});

/** C1 semesters newest first (RULE-084) and the selectable years (RULE-190). */
export const semestersView = Effect.gen(function* semestersView() {
  const semesters = yield* listSemestersNewestFirst;

  return {
    semesters: Arr.map(semesters, (semester) => ({
      id: semester.id,
      label: semesterLabel(semester),
    })),
    years: selectableYears(yield* DateTime.now),
  };
});

/** C1 fields of study of the actor's own department (RULE-139). */
export const fieldsOfStudyView = Effect.gen(function* fieldsOfStudyView() {
  const actor = yield* CurrentActor;

  if (!Predicate.isTagged("Staff")(actor)) {
    return { departmentId: null, fieldsOfStudy: [] };
  }

  const fields = yield* listFieldsOfStudy(actor.departmentId);

  return {
    departmentId: actor.departmentId,
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

/** Every block the public pages embed, with its current HTML. */
export const staticContentView = Effect.forEach(
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

/** Published articles, newest first (drafts have no staff listing query yet; see README). */
export const articlesView = Effect.gen(function* articlesView() {
  const articles = yield* ArticleRepository;
  const published = yield* articles.listPublished;

  return Arr.map(Arr.sort(published, newestArticleOrder), (article) => ({
    id: article.id,
    slug: article.slug,
    sticky: article.sticky,
    title: article.title,
  }));
});

export const sponsorInput = (form: FormData, logoKey: string | null) => ({
  logoKey,
  name: text(form, "name"),
  size: text(form, "size"),
  url: text(form, "url"),
});

export const sponsorsView = Effect.map(listSponsorsForFooter, (sponsors) =>
  Arr.map(sponsors, (sponsor) => ({
    id: sponsor.id,
    name: sponsor.name,
    size: sponsor.size,
    url: sponsor.url,
  }))
);

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

/** The actor's department's events this semester, with the RULE-085 badge. */
export const socialEventsView = Effect.gen(function* socialEventsView() {
  const actor = yield* CurrentActor;
  const departments = yield* DepartmentRepository;
  const current = yield* ensureCurrentSemester;
  const now = yield* DateTime.now;
  const allSemesters = yield* listSemestersNewestFirst;

  const events = Predicate.isTagged("Staff")(actor)
    ? yield* (yield* SocialEventRepository).list({
        departmentId: actor.departmentId,
        semesterId: current.id,
      })
    : [];

  return {
    currentSemesterId: current.id,
    departmentId: Predicate.isTagged("Staff")(actor)
      ? actor.departmentId
      : null,
    departments: Arr.map(yield* departments.list, (department) => ({
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
