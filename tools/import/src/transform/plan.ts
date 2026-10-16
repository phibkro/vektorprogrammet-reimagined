import {
  EmailAddress,
  HttpUrl,
  SemesterYear,
  SlackChannel,
  Slug,
  SponsorSize,
  StaticContentKey,
  osloParts,
  osloWallClock,
} from "@vektorprogrammet/domain";
import type {
  FileKey,
  SanitizedHtml,
  StoredContentType,
  Term,
} from "@vektorprogrammet/domain";
/**
 * The import plan: a pure function from the legacy snapshot and the resolved
 * files to the target rows and the reconciliation facts. Same input, same plan:
 * rows are processed in primary-key order and every list is built in that order.
 *
 * Mapping rules (architecture §6, spec 0001 "Data and migration"):
 * - Legacy ids are kept for every integer-keyed table (department ids are
 *   referenced from outside the database, e.g. `/kontakt/avdeling/{id}`).
 * - Semesters map to (term, year) with a numeric year (RULE-050). Identical
 *   (term, year) rows collapse into the lowest id; references are remapped and
 *   every collapse is reported (RULE-144/237 need the unique constraint).
 * - A row that breaks a target constraint is quarantined with its reasons and
 *   never repaired by guessing. Rows referencing a quarantined or absent row
 *   are quarantined too.
 * - Values are checked with the domain's own schemas (`EmailAddress`,
 *   `SlackChannel`, `HttpUrl`, `Slug`, `SponsorSize`, `StaticContentKey`), so the
 *   imported data decodes in `packages/db`'s repositories.
 * - Reasons hold column names and ids only, never values: the report must not
 *   carry personal data.
 */
import {
  Array as Arr,
  DateTime,
  Match,
  Option,
  Order,
  pipe,
  Schema,
} from "effect";

import type { FileIndex } from "../files.ts";
import type { LegacySnapshot } from "../legacy/rows.ts";
import type {
  BrokenReference,
  CollapsedSemester,
  MissingFileReference,
  Normalisation,
  QuarantinedRow,
  RowRef,
} from "../report.ts";
import { classifyReference, fileArea } from "./legacyPath.ts";
import { importRichText, richTextFilePaths } from "./richText.ts";

const unresolvedFileKey = undefined;

/** Target tables in insert (foreign-key) order, with the legacy table each comes from. */
export const TARGET_TABLES = [
  { source: "(files referenced by the tables below)", table: "public_file" },
  { source: "department", table: "department" },
  { source: "semester", table: "semester" },
  { source: "field_of_study", table: "field_of_study" },
  { source: "AdmissionPeriod", table: "admission_period" },
  { source: "article", table: "article" },
  { source: "articles_departments", table: "article_department" },
  { source: "static_content", table: "static_content" },
  { source: "sponsor", table: "sponsor" },
  { source: "event", table: "social_event" },
] as const;

export type TargetTable = (typeof TARGET_TABLES)[number]["table"];

/** Legacy columns with no target, by decision. */
export const DROPPED_COLUMNS = [
  {
    column: "role_id",
    reason: "RULE-188: the sign-up role was never enforced",
    table: "event",
  },
  {
    column: "updated",
    reason: "not part of the Phase 1 article model",
    table: "article",
  },
  {
    column: "infoMeeting_id",
    reason: "info meetings belong to Phase 3",
    table: "AdmissionPeriod",
  },
  {
    column: "id",
    reason: "the block is keyed by html_id",
    table: "static_content",
  },
] as const;

interface PublicFileRow {
  readonly key: FileKey;
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedBy: null;
  readonly legacyPath: string;
  readonly uploadedAt: DateTime.Utc;
}

interface DepartmentRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly email: string;
  readonly city: string;
  readonly address: string | null;
  readonly active: boolean;
  readonly slackChannel: string | null;
  readonly logoKey: FileKey | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

interface SemesterRow {
  readonly id: number;
  readonly term: Term;
  readonly year: number;
}

interface FieldOfStudyRow {
  readonly id: number;
  readonly departmentId: number;
  readonly name: string;
  readonly shortName: string;
}

interface AdmissionPeriodRow {
  readonly id: number;
  readonly departmentId: number;
  readonly semesterId: number;
  readonly startsAt: DateTime.Utc;
  readonly endsAt: DateTime.Utc;
}

interface ArticleRow {
  readonly id: number;
  readonly title: string;
  readonly slug: string;
  readonly body: SanitizedHtml;
  readonly imageSmallKey: FileKey;
  readonly imageLargeKey: FileKey;
  readonly sticky: boolean;
  readonly published: boolean;
  readonly authorId: number | null;
  readonly createdAt: DateTime.Utc;
}

interface ArticleDepartmentRow {
  readonly articleId: number;
  readonly departmentId: number;
}

interface StaticContentRow {
  readonly key: string;
  readonly html: SanitizedHtml;
}

interface SponsorRow {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly size: SponsorSize;
  readonly logoKey: FileKey | null;
}

interface SocialEventRow {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly startsAt: DateTime.Utc;
  readonly endsAt: DateTime.Utc;
  readonly link: string | null;
  readonly departmentId: number;
  readonly semesterId: number;
}

export interface TargetRows {
  readonly public_file: readonly PublicFileRow[];
  readonly department: readonly DepartmentRow[];
  readonly semester: readonly SemesterRow[];
  readonly field_of_study: readonly FieldOfStudyRow[];
  readonly admission_period: readonly AdmissionPeriodRow[];
  readonly article: readonly ArticleRow[];
  readonly article_department: readonly ArticleDepartmentRow[];
  readonly static_content: readonly StaticContentRow[];
  readonly sponsor: readonly SponsorRow[];
  readonly social_event: readonly SocialEventRow[];
}

export interface ImportPlan {
  readonly rows: TargetRows;
  readonly rowsIn: Readonly<Record<TargetTable, number>>;
  readonly quarantine: readonly QuarantinedRow[];
  readonly collapsedSemesters: readonly CollapsedSemester[];
  readonly missingFiles: readonly MissingFileReference[];
  readonly brokenReferences: readonly BrokenReference[];
  /** Rich-text rows whose markup the sanitizer changed. */
  readonly sanitized: readonly RowRef[];
  readonly rewrittenReferences: number;
  readonly normalisations: readonly Normalisation[];
  /** Legacy paths whose bytes equal an earlier path's file (one `public_file` row per key). */
  readonly pathsSharingContent: number;
}

/** Every legacy upload path the snapshot references (columns and rich text), for resolution. */
export const referencedFilePaths = (
  snapshot: LegacySnapshot
): readonly string[] => {
  const isText = Schema.is(Schema.String);

  const columns = Arr.flatMap(
    [
      ...Arr.map(snapshot.departments, (row) => row.logoPath),
      ...Arr.flatMap(snapshot.articles, (row) => [
        row.imageLarge,
        row.imageSmall,
      ]),
      ...Arr.map(snapshot.sponsors, (row) => row.logoImagePath),
    ],
    (value) => {
      const reference = isText(value) ? classifyReference(value) : undefined;

      return reference?._tag === "File" ? [reference.path] : [];
    }
  );

  const richText = Arr.flatMap(
    [
      ...Arr.map(snapshot.articles, (row) => row.body),
      ...Arr.map(snapshot.staticContents, (row) => row.html),
    ],
    richTextFilePaths
  );

  return [...columns, ...richText];
};

const WALL_CLOCK =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/u;

/**
 * A legacy `DATETIME` (`YYYY-MM-DD HH:MM:SS`) as an instant. Legacy wrote
 * server-local time; the server is assumed to have run on Europe/Oslo
 * (spec 0001, [INFERENCE]). Zero dates and impossible dates give `undefined`.
 */
export const parseLegacyDateTime = (text: string): DateTime.Utc | undefined => {
  const match = WALL_CLOCK.exec(text);

  if (match === null) {
    return undefined;
  }

  const { groups } = match;

  if (groups === undefined) {
    return undefined;
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second);

  if (
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59
  ) {
    return undefined;
  }

  if (second > 59) {
    return undefined;
  }

  const instant = osloWallClock({ day, hour, minute, month, second, year });
  const parts = osloParts(instant);

  return parts.year === year && parts.month === month && parts.day === day
    ? instant
    : undefined;
};

const LEGACY_TERM = { Høst: "HOST", Vår: "VAR" } as const satisfies Record<
  string,
  Term
>;

const getLegacyTerm = (value: string): Term | undefined =>
  value === "Vår" || value === "Høst" ? LEGACY_TERM[value] : undefined;

const isEmail = Schema.is(EmailAddress);
const isSlackChannel = Schema.is(SlackChannel);

const isHttpUrl = Schema.is(HttpUrl);

const isSlug = Schema.is(Slug);

const isSponsorSize = Schema.is(SponsorSize);

const isStaticContentKey = Schema.is(StaticContentKey);

const isSemesterYear = Schema.is(SemesterYear);

const COORDINATE = /^-?\d+(?:\.\d+)?$/u;

const byLegacyPath = Order.mapInput(
  Order.String,
  (file: { readonly legacyPath: string }) => file.legacyPath
);

const addEmptyTextReason = (
  reasons: string[],
  field: string,
  value: string
): void => {
  if (value.length === 0) {
    reasons.push(`${field} is empty`);
  }
};

const addEventTimeReasons = (
  reasons: string[],
  startsAt: ReturnType<typeof parseLegacyDateTime>,
  endsAt: ReturnType<typeof parseLegacyDateTime>
) => {
  if (startsAt === undefined) {
    reasons.push("startTime is not a valid date-time");
  }

  if (endsAt === undefined) {
    reasons.push("endTime is not a valid date-time");
  }

  if (
    startsAt !== undefined &&
    endsAt !== undefined &&
    !DateTime.isLessThan(startsAt, endsAt)
  ) {
    reasons.push("endTime is not after startTime");
  }
};

const addReason = (
  reasons: string[],
  condition: boolean,
  reason: string
): void => {
  if (condition) {
    reasons.push(reason);
  }
};

/** Builds the plan. Pure: no I/O, no clock, no randomness. */
export const planImport = (
  snapshot: LegacySnapshot,
  files: FileIndex
): ImportPlan => {
  const quarantine: QuarantinedRow[] = [];
  const brokenReferences: BrokenReference[] = [];
  const normalisations: Normalisation[] = [];
  const sanitized: RowRef[] = [];

  const missing: (Omit<MissingFileReference, "file"> & {
    readonly path: string;
  })[] = [];

  let rewrittenReferences = 0;

  /** Keeps the row when it has no reasons; otherwise records the quarantine. */
  const admit = (
    table: TargetTable,
    id: string,
    reasons: readonly string[]
  ): boolean => {
    if (reasons.length === 0) {
      return true;
    }

    quarantine.push({ id, reasons, table });

    return false;
  };

  /** Optional text: blank is absent (Symfony forms submit empty fields as NULL). */
  const optionalText = (
    table: TargetTable,
    id: string,
    field: string,
    value: string | null
  ) => {
    if (value === null) {
      return null;
    }

    if (value.trim() !== "") {
      return value;
    }

    normalisations.push({
      change: "blank text stored as NULL",
      field,
      id,
      table,
    });

    return null;
  };

  /** An image/file path column: the registered key, `null` when empty, `undefined` when unresolved. */
  const fileColumn = (
    table: TargetTable,
    id: string,
    field: string,
    value: string | null
  ): FileKey | null | undefined => {
    if (value === null || value.trim() === "") {
      return null;
    }

    const reference = classifyReference(value);

    return Match.valueTags(reference, {
      File: ({ path }) => {
        const file = files.get(path);

        if (file !== undefined) {
          return file.key;
        }

        missing.push({
          area: fileArea(path),
          field,
          id,
          path,
          table,
        });

        return unresolvedFileKey;
      },
      NotLegacy: () => {
        brokenReferences.push({
          field,
          id,
          kind: "not-a-legacy-file",
          table,
          target: "public_file",
          targetId: null,
        });

        return unresolvedFileKey;
      },
      Unmappable: ({ area }) => {
        brokenReferences.push({
          field,
          id,
          kind: "unmappable-file",
          table,
          target: area,
          targetId: null,
        });

        return unresolvedFileKey;
      },
    });
  };

  const richText = (
    table: TargetTable,
    id: string,
    field: string,
    html: string
  ) => {
    const imported = importRichText(html, (path) => files.get(path)?.key);

    if (imported.sanitizerChanged) {
      sanitized.push({ id, table });
    }

    rewrittenReferences += imported.rewritten;

    for (const path of imported.missing) {
      missing.push({ area: fileArea(path), field, id, path, table });
    }

    for (const area of imported.unmappable) {
      brokenReferences.push({
        field,
        id,
        kind: "unmappable-file",
        table,
        target: area,
        targetId: null,
      });
    }

    return imported.html;
  };

  /** Resolves a foreign key to a kept row, recording the reason and broken reference otherwise. */
  const reference = (
    table: TargetTable,
    id: string,
    field: string,
    target: TargetTable,
    value: number | null,
    kept: ReadonlyMap<number, number>,
    sourceIds: ReadonlySet<number>,
    reasons: string[]
  ): number | undefined => {
    if (value === null) {
      reasons.push(`${field} is NULL`);

      return undefined;
    }

    const resolved = kept.get(value);

    if (resolved !== undefined) {
      return resolved;
    }

    const kind = sourceIds.has(value) ? "quarantined-row" : "absent-row";
    reasons.push(
      `${field} references ${kind === "absent-row" ? "absent" : "quarantined"} ${target} ${value}`
    );
    brokenReferences.push({
      field,
      id,
      kind,
      table,
      target,
      targetId: String(value),
    });

    return undefined;
  };

  // public_file: one row per content key; the first legacy path (sorted) is the redirect source.
  const buildPublicFiles = () => {
    const publicFiles: PublicFileRow[] = [];
    const registeredKeys = new Set<string>();
    let pathsSharingContent = 0;

    for (const file of pipe(files.values(), Arr.sort(byLegacyPath))) {
      if (registeredKeys.has(file.key)) {
        pathsSharingContent += 1;
        continue;
      }

      registeredKeys.add(file.key);
      publicFiles.push({
        contentType: file.contentType,
        key: file.key,
        legacyPath: file.legacyPath,
        name: file.name,
        sha256: file.sha256,
        size: file.size,
        uploadedAt: file.uploadedAt,
        uploadedBy: null,
      });
    }

    return { pathsSharingContent, publicFiles };
  };

  const { publicFiles, pathsSharingContent } = buildPublicFiles();

  // department
  const departments: DepartmentRow[] = [];
  const departmentIds = new Map<number, number>();
  const cities = new Map<string, number>();

  const addDepartment = (row: LegacySnapshot["departments"][number]) => {
    const id = String(row.id);
    const reasons: string[] = [];

    addEmptyTextReason(reasons, "name", row.name);

    addEmptyTextReason(reasons, "short_name", row.shortName);

    if (row.city.length === 0) {
      reasons.push("city is empty");
    }

    if (!isEmail(row.email)) {
      reasons.push("email is not a valid e-mail address");
    }

    const firstWithCity = cities.get(row.city);

    if (firstWithCity !== undefined) {
      reasons.push(`city duplicates department ${firstWithCity}`);
    }

    if (row.active !== 0 && row.active !== 1) {
      reasons.push("active is not 0 or 1");
    }

    const slackChannel = optionalText(
      "department",
      id,
      "slack_channel",
      row.slackChannel
    );

    if (slackChannel !== null && !isSlackChannel(slackChannel)) {
      reasons.push("slackChannel is not a Slack channel (#name)");
    }

    const coordinate = (field: string, value: string | null): number | null => {
      const text = optionalText("department", id, field, value);

      if (text === null) {
        return null;
      }

      if (COORDINATE.test(text.trim())) {
        return Number(text.trim());
      }

      reasons.push(`${field} is not a decimal number`);

      return null;
    };

    const latitude = coordinate("latitude", row.latitude);
    const longitude = coordinate("longitude", row.longitude);

    // The logo is optional in the target: an unresolved logo is reported, not a quarantine.
    const logoKey =
      fileColumn("department", id, "logo_path", row.logoPath) ?? null;

    if (!admit("department", id, reasons)) {
      return;
    }

    cities.set(row.city, row.id);
    departmentIds.set(row.id, row.id);
    departments.push({
      active: row.active === 1,
      address: optionalText("department", id, "address", row.address),
      city: row.city,
      email: row.email,
      id: row.id,
      latitude,
      logoKey,
      longitude,
      name: row.name,
      shortName: row.shortName,
      slackChannel,
    });
  };

  const buildDepartments = () => {
    for (const row of snapshot.departments) {
      addDepartment(row);
    }

    return new Set(Arr.map(snapshot.departments, (row) => row.id));
  };

  const sourceDepartmentIds = buildDepartments();

  const semesters: SemesterRow[] = [];
  const semesterIds = new Map<number, number>();
  const firstByTermYear = new Map<string, SemesterRow>();
  const collapses = new Map<number, number[]>();

  const addSemester = (row: LegacySnapshot["semesters"][number]) => {
    const id = String(row.id);
    const reasons: string[] = [];
    const term = getLegacyTerm(row.semesterTime);

    if (term === undefined) {
      reasons.push("semesterTime is neither 'Vår' nor 'Høst'");
    }

    const year = /^\d{4}$/u.test(row.year) ? Number(row.year) : Number.NaN;

    if (!isSemesterYear(year)) {
      reasons.push("year is not a four-digit year between 1900 and 9999");
    }

    if (!admit("semester", id, reasons) || term === undefined) {
      return;
    }

    const termYear = `${term} ${year}`;
    const kept = firstByTermYear.get(termYear);

    if (kept === undefined) {
      const semester: SemesterRow = { id: row.id, term, year };
      firstByTermYear.set(termYear, semester);
      semesterIds.set(row.id, row.id);
      semesters.push(semester);
    } else {
      semesterIds.set(row.id, kept.id);
      collapses.set(kept.id, [...(collapses.get(kept.id) ?? []), row.id]);
    }
  };

  const buildSemesters = () => {
    for (const row of snapshot.semesters) {
      addSemester(row);
    }

    const collapsedSemesters = Arr.flatMap(semesters, (semester) => {
      const collapsedIds = collapses.get(semester.id);

      return collapsedIds === undefined
        ? []
        : [
            {
              collapsedIds,
              keptId: semester.id,
              term: semester.term,
              year: semester.year,
            },
          ];
    });

    const sourceSemesterIds = new Set(
      Arr.map(snapshot.semesters, (row) => row.id)
    );

    return { collapsedSemesters, sourceSemesterIds };
  };

  const { collapsedSemesters, sourceSemesterIds } = buildSemesters();

  // field_of_study
  const buildFieldsOfStudy = () => {
    const fieldsOfStudy: FieldOfStudyRow[] = [];

    for (const row of snapshot.fieldsOfStudy) {
      const id = String(row.id);
      const reasons: string[] = [];

      const departmentId = reference(
        "field_of_study",
        id,
        "department_id",
        "department",
        row.departmentId,
        departmentIds,
        sourceDepartmentIds,
        reasons
      );

      addEmptyTextReason(reasons, "name", row.name);

      addEmptyTextReason(reasons, "short_name", row.shortName);

      if (!admit("field_of_study", id, reasons) || departmentId === undefined) {
        continue;
      }

      fieldsOfStudy.push({
        departmentId,
        id: row.id,
        name: row.name,
        shortName: row.shortName,
      });
    }

    return fieldsOfStudy;
  };

  const fieldsOfStudy = buildFieldsOfStudy();

  // admission_period
  const admissionPeriods: AdmissionPeriodRow[] = [];

  const addAdmissionPeriod = (
    row: LegacySnapshot["admissionPeriods"][number]
  ) => {
    const id = String(row.id);
    const reasons: string[] = [];

    const departmentId = reference(
      "admission_period",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons
    );

    const semesterId = reference(
      "admission_period",
      id,
      "semester_id",
      "semester",
      row.semesterId,
      semesterIds,
      sourceSemesterIds,
      reasons
    );

    const startsAt = parseLegacyDateTime(row.startDate);
    const endsAt = parseLegacyDateTime(row.endDate);

    if (startsAt === undefined) {
      reasons.push("start_date is not a valid date-time");
    }

    if (endsAt === undefined) {
      reasons.push("end_date is not a valid date-time");
    }

    if (
      startsAt !== undefined &&
      endsAt !== undefined &&
      !DateTime.isLessThan(startsAt, endsAt)
    ) {
      reasons.push("end_date is not after start_date");
    }

    if (
      !admit("admission_period", id, reasons) ||
      departmentId === undefined ||
      semesterId === undefined ||
      startsAt === undefined ||
      endsAt === undefined
    ) {
      return;
    }

    admissionPeriods.push({
      departmentId,
      endsAt,
      id: row.id,
      semesterId,
      startsAt,
    });
  };

  const buildAdmissionPeriods = () => {
    for (const row of snapshot.admissionPeriods) {
      addAdmissionPeriod(row);
    }
  };

  buildAdmissionPeriods();

  // article
  const articles: ArticleRow[] = [];
  const articleIds = new Map<number, number>();
  const slugs = new Map<string, number>();

  const addArticle = (row: LegacySnapshot["articles"][number]) => {
    const id = String(row.id);
    const reasons: string[] = [];

    addEmptyTextReason(reasons, "title", row.title);
    addReason(
      reasons,
      !isSlug(row.slug),
      "slug is not a URL slug ([a-z0-9-], at most 255)"
    );

    const firstWithSlug = slugs.get(row.slug);
    addReason(
      reasons,
      firstWithSlug !== undefined,
      `slug duplicates article ${firstWithSlug}`
    );

    const createdAt = parseLegacyDateTime(row.created);
    addReason(
      reasons,
      createdAt === undefined,
      "created is not a valid date-time"
    );
    addReason(
      reasons,
      row.sticky !== 0 && row.sticky !== 1,
      "sticky is not 0 or 1"
    );
    addReason(
      reasons,
      row.published !== null && row.published !== 0 && row.published !== 1,
      "published is not 0, 1 or NULL"
    );
    addReason(
      reasons,
      row.authorId !== null && row.authorId < 1,
      "author_id is not a positive id"
    );

    const imageLargeKey = Option.fromNullishOr(
      fileColumn("article", id, "imageLarge", row.imageLarge)
    );

    const imageSmallKey = Option.fromNullishOr(
      fileColumn("article", id, "imageSmall", row.imageSmall)
    );

    addReason(
      reasons,
      Option.isNone(imageLargeKey),
      "imageLarge has no registered file"
    );
    addReason(
      reasons,
      Option.isNone(imageSmallKey),
      "imageSmall has no registered file"
    );

    const body = richText("article", id, "article", row.body);

    if (
      !admit("article", id, reasons) ||
      createdAt === undefined ||
      Option.isNone(imageLargeKey) ||
      Option.isNone(imageSmallKey)
    ) {
      return;
    }

    if (row.published === null) {
      normalisations.push({
        change: "NULL stored as false (draft)",
        field: "published",
        id,
        table: "article",
      });
    }

    slugs.set(row.slug, row.id);
    articleIds.set(row.id, row.id);
    articles.push({
      authorId: row.authorId,
      body,
      createdAt,
      id: row.id,
      imageLargeKey: imageLargeKey.value,
      imageSmallKey: imageSmallKey.value,
      published: row.published === 1,
      slug: row.slug,
      sticky: row.sticky === 1,
      title: row.title,
    });
  };

  const buildArticles = () => {
    for (const row of snapshot.articles) {
      addArticle(row);
    }

    return new Set(Arr.map(snapshot.articles, (row) => row.id));
  };

  const sourceArticleIds = buildArticles();

  // article_department
  const buildArticleDepartments = () => {
    const articleDepartments: ArticleDepartmentRow[] = [];

    for (const row of snapshot.articleDepartments) {
      const id = `${row.articleId}:${row.departmentId}`;
      const reasons: string[] = [];

      const articleId = reference(
        "article_department",
        id,
        "article_id",
        "article",
        row.articleId,
        articleIds,
        sourceArticleIds,
        reasons
      );

      const departmentId = reference(
        "article_department",
        id,
        "department_id",
        "department",
        row.departmentId,
        departmentIds,
        sourceDepartmentIds,
        reasons
      );

      if (
        !admit("article_department", id, reasons) ||
        articleId === undefined ||
        departmentId === undefined
      ) {
        continue;
      }

      articleDepartments.push({ articleId, departmentId });
    }

    return articleDepartments;
  };

  const articleDepartments = buildArticleDepartments();

  // static_content
  const buildStaticContents = () => {
    const staticContents: StaticContentRow[] = [];
    const blockKeys = new Map<string, number>();

    for (const row of snapshot.staticContents) {
      const id = String(row.id);
      const reasons: string[] = [];

      if (!isStaticContentKey(row.htmlId)) {
        reasons.push("html_id is empty or longer than 50");
      }

      const first = blockKeys.get(row.htmlId);

      if (first !== undefined) {
        reasons.push(`html_id duplicates static_content ${first}`);
      }

      const html = richText("static_content", id, "html", row.html);

      if (!admit("static_content", id, reasons)) {
        continue;
      }

      blockKeys.set(row.htmlId, row.id);
      staticContents.push({ html, key: row.htmlId });
    }

    return staticContents;
  };

  const staticContents = buildStaticContents();

  // sponsor
  const sponsors: SponsorRow[] = [];

  const addSponsor = (row: LegacySnapshot["sponsors"][number]) => {
    const id = String(row.id);
    const reasons: string[] = [];

    if (row.name === null || row.name.length === 0) {
      reasons.push("name is empty");
    }

    if (row.url === null || !isHttpUrl(row.url)) {
      reasons.push("url is not an absolute http(s) URL");
    }

    if (row.size === null || !isSponsorSize(row.size)) {
      reasons.push("size is not small, medium or large");
    }

    const logoKey =
      fileColumn("sponsor", id, "logoImagePath", row.logoImagePath) ?? null;

    if (
      !admit("sponsor", id, reasons) ||
      row.name === null ||
      row.url === null ||
      row.size === null ||
      !isSponsorSize(row.size)
    ) {
      return;
    }

    sponsors.push({
      id: row.id,
      logoKey,
      name: row.name,
      size: row.size,
      url: row.url,
    });
  };

  const buildSponsors = () => {
    for (const row of snapshot.sponsors) {
      addSponsor(row);
    }
  };

  buildSponsors();

  // social_event (role_id is not read: RULE-188)
  const socialEvents: SocialEventRow[] = [];

  const addSocialEvent = (row: LegacySnapshot["socialEvents"][number]) => {
    const id = String(row.id);
    const reasons: string[] = [];

    const departmentId = reference(
      "social_event",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons
    );

    const semesterId = reference(
      "social_event",
      id,
      "semester_id",
      "semester",
      row.semesterId,
      semesterIds,
      sourceSemesterIds,
      reasons
    );

    if (row.title.length === 0) {
      reasons.push("title is empty");
    }

    if (row.description.length > 5000) {
      reasons.push("description is longer than 5000");
    }

    const link = optionalText("social_event", id, "link", row.link);

    if (link !== null && link.length > 250) {
      reasons.push("link is longer than 250");
    }

    const startsAt = parseLegacyDateTime(row.startTime);
    const endsAt = parseLegacyDateTime(row.endTime);
    addEventTimeReasons(reasons, startsAt, endsAt);

    if (
      !admit("social_event", id, reasons) ||
      departmentId === undefined ||
      semesterId === undefined ||
      startsAt === undefined ||
      endsAt === undefined
    ) {
      return;
    }

    socialEvents.push({
      departmentId,
      description: row.description,
      endsAt,
      id: row.id,
      link,
      semesterId,
      startsAt,
      title: row.title,
    });
  };

  const buildSocialEvents = () => {
    for (const row of snapshot.socialEvents) {
      addSocialEvent(row);
    }
  };

  buildSocialEvents();

  const missingPaths = pipe(
    new Set(Arr.map(missing, (entry) => entry.path)),
    Arr.sort(Order.String)
  );

  const ordinal = new Map(
    Arr.map(missingPaths, (path, index) => [path, `missing-file-${index + 1}`])
  );

  return {
    brokenReferences,
    collapsedSemesters,
    missingFiles: Arr.map(missing, ({ path, ...entry }) => ({
      ...entry,
      file: ordinal.get(path) ?? "",
    })),
    normalisations,
    pathsSharingContent,
    quarantine,
    rewrittenReferences,
    rows: {
      admission_period: admissionPeriods,
      article: articles,
      article_department: articleDepartments,
      department: departments,
      field_of_study: fieldsOfStudy,
      public_file: publicFiles,
      semester: semesters,
      social_event: socialEvents,
      sponsor: sponsors,
      static_content: staticContents,
    },
    rowsIn: {
      admission_period: snapshot.admissionPeriods.length,
      article: snapshot.articles.length,
      article_department: snapshot.articleDepartments.length,
      department: snapshot.departments.length,
      field_of_study: snapshot.fieldsOfStudy.length,
      public_file: new Set(referencedFilePaths(snapshot)).size,
      semester: snapshot.semesters.length,
      social_event: snapshot.socialEvents.length,
      sponsor: snapshot.sponsors.length,
      static_content: snapshot.staticContents.length,
    },
    sanitized,
  };
};
