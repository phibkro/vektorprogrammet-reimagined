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
import { DateTime, Schema } from "effect";
import {
  EmailAddress,
  type FileKey,
  HttpUrl,
  type SanitizedHtml,
  SemesterYear,
  SlackChannel,
  Slug,
  SponsorSize,
  StaticContentKey,
  type StoredContentType,
  type Term,
  osloParts,
  osloWallClock,
} from "@vektorprogrammet/domain";
import type { FileIndex } from "../files.ts";
import type {
  BrokenReference,
  CollapsedSemester,
  MissingFileReference,
  Normalisation,
  QuarantinedRow,
  RowRef,
} from "../report.ts";
import type { LegacySnapshot } from "../legacy/rows.ts";
import { classifyReference, fileArea } from "./legacyPath.ts";
import { importRichText, richTextFilePaths } from "./richText.ts";

/** Target tables in insert (foreign-key) order, with the legacy table each comes from. */
export const TARGET_TABLES = [
  { table: "public_file", source: "(files referenced by the tables below)" },
  { table: "department", source: "department" },
  { table: "semester", source: "semester" },
  { table: "field_of_study", source: "field_of_study" },
  { table: "admission_period", source: "AdmissionPeriod" },
  { table: "article", source: "article" },
  { table: "article_department", source: "articles_departments" },
  { table: "static_content", source: "static_content" },
  { table: "sponsor", source: "sponsor" },
  { table: "social_event", source: "event" },
] as const;
export type TargetTable = (typeof TARGET_TABLES)[number]["table"];

/** Legacy columns with no target, by decision. */
export const DROPPED_COLUMNS = [
  { table: "event", column: "role_id", reason: "RULE-188: the sign-up role was never enforced" },
  { table: "article", column: "updated", reason: "not part of the Phase 1 article model" },
  { table: "AdmissionPeriod", column: "infoMeeting_id", reason: "info meetings belong to Phase 3" },
  { table: "static_content", column: "id", reason: "the block is keyed by html_id" },
] as const;

export interface PublicFileRow {
  readonly key: FileKey;
  readonly name: string;
  readonly contentType: StoredContentType;
  readonly size: number;
  readonly sha256: string;
  readonly uploadedBy: null;
  readonly legacyPath: string;
  readonly uploadedAt: DateTime.Utc;
}

export interface DepartmentRow {
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

export interface SemesterRow {
  readonly id: number;
  readonly term: Term;
  readonly year: number;
}

export interface FieldOfStudyRow {
  readonly id: number;
  readonly departmentId: number;
  readonly name: string;
  readonly shortName: string;
}

export interface AdmissionPeriodRow {
  readonly id: number;
  readonly departmentId: number;
  readonly semesterId: number;
  readonly startsAt: DateTime.Utc;
  readonly endsAt: DateTime.Utc;
}

export interface ArticleRow {
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

export interface ArticleDepartmentRow {
  readonly articleId: number;
  readonly departmentId: number;
}

export interface StaticContentRow {
  readonly key: string;
  readonly html: SanitizedHtml;
}

export interface SponsorRow {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly size: SponsorSize;
  readonly logoKey: FileKey | null;
}

export interface SocialEventRow {
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
  readonly public_file: ReadonlyArray<PublicFileRow>;
  readonly department: ReadonlyArray<DepartmentRow>;
  readonly semester: ReadonlyArray<SemesterRow>;
  readonly field_of_study: ReadonlyArray<FieldOfStudyRow>;
  readonly admission_period: ReadonlyArray<AdmissionPeriodRow>;
  readonly article: ReadonlyArray<ArticleRow>;
  readonly article_department: ReadonlyArray<ArticleDepartmentRow>;
  readonly static_content: ReadonlyArray<StaticContentRow>;
  readonly sponsor: ReadonlyArray<SponsorRow>;
  readonly social_event: ReadonlyArray<SocialEventRow>;
}

export interface ImportPlan {
  readonly rows: TargetRows;
  readonly rowsIn: Readonly<Record<TargetTable, number>>;
  readonly quarantine: ReadonlyArray<QuarantinedRow>;
  readonly collapsedSemesters: ReadonlyArray<CollapsedSemester>;
  readonly missingFiles: ReadonlyArray<MissingFileReference>;
  readonly brokenReferences: ReadonlyArray<BrokenReference>;
  /** Rich-text rows whose markup the sanitizer changed. */
  readonly sanitized: ReadonlyArray<RowRef>;
  readonly rewrittenReferences: number;
  readonly normalisations: ReadonlyArray<Normalisation>;
  /** Legacy paths whose bytes equal an earlier path's file (one `public_file` row per key). */
  readonly pathsSharingContent: number;
}

/** Every legacy upload path the snapshot references (columns and rich text), for resolution. */
export const referencedFilePaths = (snapshot: LegacySnapshot): ReadonlyArray<string> => {
  const columns = [
    ...snapshot.departments.map((row) => row.logoPath),
    ...snapshot.articles.flatMap((row) => [row.imageLarge, row.imageSmall]),
    ...snapshot.sponsors.map((row) => row.logoImagePath),
  ].flatMap((value) => {
    const reference = value === null ? undefined : classifyReference(value);
    return reference?._tag === "File" ? [reference.path] : [];
  });
  const richText = [
    ...snapshot.articles.map((row) => row.body),
    ...snapshot.staticContents.map((row) => row.html),
  ].flatMap(richTextFilePaths);
  return [...columns, ...richText];
};

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * A legacy `DATETIME` (`YYYY-MM-DD HH:MM:SS`) as an instant. Legacy wrote
 * server-local time; the server is assumed to have run on Europe/Oslo
 * (spec 0001, [INFERENCE]). Zero dates and impossible dates give `undefined`.
 */
export const parseLegacyDateTime = (text: string): DateTime.Utc | undefined => {
  const match = WALL_CLOCK.exec(text);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) {
    return undefined;
  }
  if (second > 59) return undefined;
  const instant = osloWallClock({ year, month, day, hour, minute, second });
  const parts = osloParts(instant);
  return parts.year === year && parts.month === month && parts.day === day ? instant : undefined;
};

const LEGACY_TERM: Record<string, Term> = { Vår: "VAR", Høst: "HOST" };
const isEmail = Schema.is(EmailAddress);
const isSlackChannel = Schema.is(SlackChannel);
const isHttpUrl = Schema.is(HttpUrl);
const isSlug = Schema.is(Slug);
const isSponsorSize = Schema.is(SponsorSize);
const isStaticContentKey = Schema.is(StaticContentKey);
const isSemesterYear = Schema.is(SemesterYear);
const COORDINATE = /^-?\d+(\.\d+)?$/;

/** Builds the plan. Pure: no I/O, no clock, no randomness. */
export const planImport = (snapshot: LegacySnapshot, files: FileIndex): ImportPlan => {
  const quarantine: Array<QuarantinedRow> = [];
  const brokenReferences: Array<BrokenReference> = [];
  const normalisations: Array<Normalisation> = [];
  const sanitized: Array<RowRef> = [];
  const missing: Array<Omit<MissingFileReference, "file"> & { readonly path: string }> = [];
  let rewrittenReferences = 0;

  /** Keeps the row when it has no reasons; otherwise records the quarantine. */
  const admit = (table: TargetTable, id: string, reasons: ReadonlyArray<string>): boolean => {
    if (reasons.length === 0) return true;
    quarantine.push({ table, id, reasons });
    return false;
  };

  /** Optional text: blank is absent (Symfony forms submit empty fields as NULL). */
  const optionalText = (table: TargetTable, id: string, field: string, value: string | null) => {
    if (value === null) return null;
    if (value.trim() !== "") return value;
    normalisations.push({ table, id, field, change: "blank text stored as NULL" });
    return null;
  };

  /** An image/file path column: the registered key, `null` when empty, `undefined` when unresolved. */
  const fileColumn = (
    table: TargetTable,
    id: string,
    field: string,
    value: string | null,
  ): FileKey | null | undefined => {
    if (value === null || value.trim() === "") return null;
    const reference = classifyReference(value);
    switch (reference._tag) {
      case "NotLegacy":
        brokenReferences.push({
          table,
          id,
          field,
          kind: "not-a-legacy-file",
          target: "public_file",
          targetId: null,
        });
        return undefined;
      case "Unmappable":
        brokenReferences.push({
          table,
          id,
          field,
          kind: "unmappable-file",
          target: reference.area,
          targetId: null,
        });
        return undefined;
      case "File": {
        const file = files.get(reference.path);
        if (file !== undefined) return file.key;
        missing.push({ table, id, field, area: fileArea(reference.path), path: reference.path });
        return undefined;
      }
    }
  };

  const richText = (table: TargetTable, id: string, field: string, html: string) => {
    const imported = importRichText(html, (path) => files.get(path)?.key);
    if (imported.sanitizerChanged) sanitized.push({ table, id });
    rewrittenReferences += imported.rewritten;
    for (const path of imported.missing) {
      missing.push({ table, id, field, area: fileArea(path), path });
    }
    for (const area of imported.unmappable) {
      brokenReferences.push({
        table,
        id,
        field,
        kind: "unmappable-file",
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
    reasons: Array<string>,
  ): number | undefined => {
    if (value === null) {
      reasons.push(`${field} is NULL`);
      return undefined;
    }
    const resolved = kept.get(value);
    if (resolved !== undefined) return resolved;
    const kind = sourceIds.has(value) ? "quarantined-row" : "absent-row";
    reasons.push(
      `${field} references ${kind === "absent-row" ? "absent" : "quarantined"} ${target} ${value}`,
    );
    brokenReferences.push({ table, id, field, kind, target, targetId: String(value) });
    return undefined;
  };

  // public_file: one row per content key; the first legacy path (sorted) is the redirect source.
  const publicFiles: Array<PublicFileRow> = [];
  const registeredKeys = new Set<string>();
  let pathsSharingContent = 0;
  for (const file of Array.from(files.values()).sort((a, b) =>
    a.legacyPath < b.legacyPath ? -1 : a.legacyPath > b.legacyPath ? 1 : 0,
  )) {
    if (registeredKeys.has(file.key)) {
      pathsSharingContent += 1;
      continue;
    }
    registeredKeys.add(file.key);
    publicFiles.push({
      key: file.key,
      name: file.name,
      contentType: file.contentType,
      size: file.size,
      sha256: file.sha256,
      uploadedBy: null,
      legacyPath: file.legacyPath,
      uploadedAt: file.uploadedAt,
    });
  }

  // department
  const departments: Array<DepartmentRow> = [];
  const departmentIds = new Map<number, number>();
  const cities = new Map<string, number>();
  for (const row of snapshot.departments) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    if (row.name.length === 0) reasons.push("name is empty");
    if (row.shortName.length === 0) reasons.push("short_name is empty");
    if (row.city.length === 0) reasons.push("city is empty");
    if (!isEmail(row.email)) reasons.push("email is not a valid e-mail address");
    const firstWithCity = cities.get(row.city);
    if (firstWithCity !== undefined) reasons.push(`city duplicates department ${firstWithCity}`);
    if (row.active !== 0 && row.active !== 1) reasons.push("active is not 0 or 1");
    const slackChannel = optionalText("department", id, "slack_channel", row.slackChannel);
    if (slackChannel !== null && !isSlackChannel(slackChannel)) {
      reasons.push("slackChannel is not a Slack channel (#name)");
    }
    const coordinate = (field: string, value: string | null): number | null => {
      const text = optionalText("department", id, field, value);
      if (text === null) return null;
      if (COORDINATE.test(text.trim())) return Number(text.trim());
      reasons.push(`${field} is not a decimal number`);
      return null;
    };
    const latitude = coordinate("latitude", row.latitude);
    const longitude = coordinate("longitude", row.longitude);
    // The logo is optional in the target: an unresolved logo is reported, not a quarantine.
    const logoKey = fileColumn("department", id, "logo_path", row.logoPath) ?? null;
    if (!admit("department", id, reasons)) continue;
    cities.set(row.city, row.id);
    departmentIds.set(row.id, row.id);
    departments.push({
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      email: row.email,
      city: row.city,
      address: optionalText("department", id, "address", row.address),
      active: row.active === 1,
      slackChannel,
      logoKey,
      latitude,
      longitude,
    });
  }
  const sourceDepartmentIds = new Set(snapshot.departments.map((row) => row.id));

  // semester
  const semesters: Array<SemesterRow> = [];
  const semesterIds = new Map<number, number>();
  const firstByTermYear = new Map<string, SemesterRow>();
  const collapses = new Map<number, Array<number>>();
  for (const row of snapshot.semesters) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    const term = LEGACY_TERM[row.semesterTime];
    if (term === undefined) reasons.push("semesterTime is neither 'Vår' nor 'Høst'");
    const year = /^\d{4}$/.test(row.year) ? Number(row.year) : Number.NaN;
    if (!isSemesterYear(year)) reasons.push("year is not a four-digit year between 1900 and 9999");
    if (!admit("semester", id, reasons) || term === undefined) continue;
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
  }
  const collapsedSemesters = semesters.flatMap((semester) => {
    const collapsedIds = collapses.get(semester.id);
    return collapsedIds === undefined
      ? []
      : [{ term: semester.term, year: semester.year, keptId: semester.id, collapsedIds }];
  });
  const sourceSemesterIds = new Set(snapshot.semesters.map((row) => row.id));

  // field_of_study
  const fieldsOfStudy: Array<FieldOfStudyRow> = [];
  for (const row of snapshot.fieldsOfStudy) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    const departmentId = reference(
      "field_of_study",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons,
    );
    if (row.name.length === 0) reasons.push("name is empty");
    if (row.shortName.length === 0) reasons.push("short_name is empty");
    if (!admit("field_of_study", id, reasons) || departmentId === undefined) continue;
    fieldsOfStudy.push({ id: row.id, departmentId, name: row.name, shortName: row.shortName });
  }

  // admission_period
  const admissionPeriods: Array<AdmissionPeriodRow> = [];
  for (const row of snapshot.admissionPeriods) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    const departmentId = reference(
      "admission_period",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons,
    );
    const semesterId = reference(
      "admission_period",
      id,
      "semester_id",
      "semester",
      row.semesterId,
      semesterIds,
      sourceSemesterIds,
      reasons,
    );
    const startsAt = parseLegacyDateTime(row.startDate);
    const endsAt = parseLegacyDateTime(row.endDate);
    if (startsAt === undefined) reasons.push("start_date is not a valid date-time");
    if (endsAt === undefined) reasons.push("end_date is not a valid date-time");
    if (startsAt !== undefined && endsAt !== undefined && !DateTime.isLessThan(startsAt, endsAt)) {
      reasons.push("end_date is not after start_date");
    }
    if (
      !admit("admission_period", id, reasons) ||
      departmentId === undefined ||
      semesterId === undefined ||
      startsAt === undefined ||
      endsAt === undefined
    ) {
      continue;
    }
    admissionPeriods.push({ id: row.id, departmentId, semesterId, startsAt, endsAt });
  }

  // article
  const articles: Array<ArticleRow> = [];
  const articleIds = new Map<number, number>();
  const slugs = new Map<string, number>();
  for (const row of snapshot.articles) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    if (row.title.length === 0) reasons.push("title is empty");
    if (!isSlug(row.slug)) reasons.push("slug is not a URL slug ([a-z0-9-], at most 255)");
    const firstWithSlug = slugs.get(row.slug);
    if (firstWithSlug !== undefined) reasons.push(`slug duplicates article ${firstWithSlug}`);
    const createdAt = parseLegacyDateTime(row.created);
    if (createdAt === undefined) reasons.push("created is not a valid date-time");
    if (row.sticky !== 0 && row.sticky !== 1) reasons.push("sticky is not 0 or 1");
    if (row.published !== null && row.published !== 0 && row.published !== 1) {
      reasons.push("published is not 0, 1 or NULL");
    }
    if (row.authorId !== null && row.authorId < 1) reasons.push("author_id is not a positive id");
    const imageLargeKey = fileColumn("article", id, "imageLarge", row.imageLarge);
    const imageSmallKey = fileColumn("article", id, "imageSmall", row.imageSmall);
    if (imageLargeKey == null) reasons.push("imageLarge has no registered file");
    if (imageSmallKey == null) reasons.push("imageSmall has no registered file");
    const body = richText("article", id, "article", row.body);
    if (
      !admit("article", id, reasons) ||
      createdAt === undefined ||
      imageLargeKey == null ||
      imageSmallKey == null
    ) {
      continue;
    }
    if (row.published === null) {
      // Legacy `isPublished()` is falsy for NULL, so the article was a draft (RULE-267).
      normalisations.push({
        table: "article",
        id,
        field: "published",
        change: "NULL stored as false (draft)",
      });
    }
    slugs.set(row.slug, row.id);
    articleIds.set(row.id, row.id);
    articles.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      body,
      imageSmallKey,
      imageLargeKey,
      sticky: row.sticky === 1,
      published: row.published === 1,
      authorId: row.authorId,
      createdAt,
    });
  }
  const sourceArticleIds = new Set(snapshot.articles.map((row) => row.id));

  // article_department
  const articleDepartments: Array<ArticleDepartmentRow> = [];
  for (const row of snapshot.articleDepartments) {
    const id = `${row.articleId}:${row.departmentId}`;
    const reasons: Array<string> = [];
    const articleId = reference(
      "article_department",
      id,
      "article_id",
      "article",
      row.articleId,
      articleIds,
      sourceArticleIds,
      reasons,
    );
    const departmentId = reference(
      "article_department",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons,
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

  // static_content
  const staticContents: Array<StaticContentRow> = [];
  const blockKeys = new Map<string, number>();
  for (const row of snapshot.staticContents) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    if (!isStaticContentKey(row.htmlId)) reasons.push("html_id is empty or longer than 50");
    const first = blockKeys.get(row.htmlId);
    if (first !== undefined) reasons.push(`html_id duplicates static_content ${first}`);
    const html = richText("static_content", id, "html", row.html);
    if (!admit("static_content", id, reasons)) continue;
    blockKeys.set(row.htmlId, row.id);
    staticContents.push({ key: row.htmlId, html });
  }

  // sponsor
  const sponsors: Array<SponsorRow> = [];
  for (const row of snapshot.sponsors) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    if (row.name === null || row.name.length === 0) reasons.push("name is empty");
    if (row.url === null || !isHttpUrl(row.url)) reasons.push("url is not an absolute http(s) URL");
    if (row.size === null || !isSponsorSize(row.size)) {
      reasons.push("size is not small, medium or large");
    }
    const logoKey = fileColumn("sponsor", id, "logoImagePath", row.logoImagePath) ?? null;
    if (
      !admit("sponsor", id, reasons) ||
      row.name === null ||
      row.url === null ||
      row.size === null ||
      !isSponsorSize(row.size)
    ) {
      continue;
    }
    sponsors.push({ id: row.id, name: row.name, url: row.url, size: row.size, logoKey });
  }

  // social_event (role_id is not read: RULE-188)
  const socialEvents: Array<SocialEventRow> = [];
  for (const row of snapshot.socialEvents) {
    const id = String(row.id);
    const reasons: Array<string> = [];
    const departmentId = reference(
      "social_event",
      id,
      "department_id",
      "department",
      row.departmentId,
      departmentIds,
      sourceDepartmentIds,
      reasons,
    );
    const semesterId = reference(
      "social_event",
      id,
      "semester_id",
      "semester",
      row.semesterId,
      semesterIds,
      sourceSemesterIds,
      reasons,
    );
    if (row.title.length === 0) reasons.push("title is empty");
    if (row.description.length > 5000) reasons.push("description is longer than 5000");
    const link = optionalText("social_event", id, "link", row.link);
    if (link !== null && link.length > 250) reasons.push("link is longer than 250");
    const startsAt = parseLegacyDateTime(row.startTime);
    const endsAt = parseLegacyDateTime(row.endTime);
    if (startsAt === undefined) reasons.push("startTime is not a valid date-time");
    if (endsAt === undefined) reasons.push("endTime is not a valid date-time");
    if (startsAt !== undefined && endsAt !== undefined && !DateTime.isLessThan(startsAt, endsAt)) {
      reasons.push("endTime is not after startTime");
    }
    if (
      !admit("social_event", id, reasons) ||
      departmentId === undefined ||
      semesterId === undefined ||
      startsAt === undefined ||
      endsAt === undefined
    ) {
      continue;
    }
    socialEvents.push({
      id: row.id,
      title: row.title,
      description: row.description,
      startsAt,
      endsAt,
      link,
      departmentId,
      semesterId,
    });
  }

  const missingPaths = Array.from(new Set(missing.map((entry) => entry.path))).sort();
  const ordinal = new Map(missingPaths.map((path, index) => [path, `missing-file-${index + 1}`]));

  return {
    rows: {
      public_file: publicFiles,
      department: departments,
      semester: semesters,
      field_of_study: fieldsOfStudy,
      admission_period: admissionPeriods,
      article: articles,
      article_department: articleDepartments,
      static_content: staticContents,
      sponsor: sponsors,
      social_event: socialEvents,
    },
    rowsIn: {
      public_file: new Set(referencedFilePaths(snapshot)).size,
      department: snapshot.departments.length,
      semester: snapshot.semesters.length,
      field_of_study: snapshot.fieldsOfStudy.length,
      admission_period: snapshot.admissionPeriods.length,
      article: snapshot.articles.length,
      article_department: snapshot.articleDepartments.length,
      static_content: snapshot.staticContents.length,
      sponsor: snapshot.sponsors.length,
      social_event: snapshot.socialEvents.length,
    },
    quarantine,
    collapsedSemesters,
    missingFiles: missing.map(({ path, ...entry }) => ({
      ...entry,
      file: ordinal.get(path) ?? "",
    })),
    brokenReferences,
    sanitized,
    rewrittenReferences,
    normalisations,
    pathsSharingContent,
  };
};
