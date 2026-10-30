import {
  EmailAddress,
  SemesterYear,
  SlackChannel,
  TargetTable,
  osloParts,
  osloWallClock,
} from "@vektorprogrammet/domain";
import type { FileKey, TargetRows, Term } from "@vektorprogrammet/domain";
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
 * - Values are checked with the domain's own schemas (`EmailAddress`, `SlackChannel`, `SemesterYear`), so the
 *   imported data decodes in `packages/db`'s repositories.
 * - Reasons hold column names and ids only, never values: the report must not
 *   carry personal data.
 */
import { Array as Arr, DateTime, Match, Order, pipe, Schema } from "effect";

import type { FileIndex } from "../files.ts";
import type { LegacySnapshot } from "../legacy/rows.ts";
import type {
  BrokenReference,
  CollapsedSemester,
  MissingFileReference,
  Normalisation,
  QuarantinedRow,
} from "../report.ts";
import { classifyReference, fileArea } from "./legacyPath.ts";

const unresolvedFileKey = undefined;

/** The legacy table that each target table comes from. */
const SOURCES: Readonly<Record<TargetTable, string>> = {
  admission_period: "AdmissionPeriod",
  department: "department",
  field_of_study: "field_of_study",
  public_file: "(files referenced by the tables below)",
  semester: "semester",
  social_event: "event",
};

/** Target tables in insert (foreign-key) order (the domain's declaration), with the legacy table each comes from. */
export const TARGET_TABLES = Arr.map(TargetTable.literals, (table) => ({
  source: SOURCES[table],
  table,
}));

type PublicFileRow = TargetRows["public_file"][number];

type DepartmentRow = TargetRows["department"][number];

type SemesterRow = TargetRows["semester"][number];

type FieldOfStudyRow = TargetRows["field_of_study"][number];

type AdmissionPeriodRow = TargetRows["admission_period"][number];

type SocialEventRow = TargetRows["social_event"][number];

/** Legacy columns with no target, by decision. */
export const DROPPED_COLUMNS = [
  {
    column: "role_id",
    reason: "RULE-188: the sign-up role was never enforced",
    table: "event",
  },
  {
    column: "infoMeeting_id",
    reason: "info meetings belong to Phase 3",
    table: "AdmissionPeriod",
  },
] as const;

export interface ImportPlan {
  readonly rows: TargetRows;
  readonly rowsIn: Readonly<Record<TargetTable, number>>;
  readonly quarantine: readonly QuarantinedRow[];
  readonly collapsedSemesters: readonly CollapsedSemester[];
  readonly missingFiles: readonly MissingFileReference[];
  readonly brokenReferences: readonly BrokenReference[];
  readonly normalisations: readonly Normalisation[];
  /** Legacy paths whose bytes equal an earlier path's file (one `public_file` row per key). */
  readonly pathsSharingContent: number;
}

/** Every legacy upload path the snapshot references (columns and rich text), for resolution. */
export const referencedFilePaths = (
  snapshot: LegacySnapshot
): readonly string[] => {
  const isText = Schema.is(Schema.String);

  return Arr.flatMap(
    Arr.map(snapshot.departments, (row) => row.logoPath),
    (value) => {
      const reference = isText(value) ? classifyReference(value) : undefined;

      return reference?._tag === "File" ? [reference.path] : [];
    }
  );
};

const WALL_CLOCK =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/u;

/**
 * A legacy `DATETIME` (`YYYY-MM-DD HH:MM:SS`) as an instant. Legacy wrote
 * server-local time; the server is assumed to have run on Europe/Oslo
 * (spec 0001, [INFERENCE]). Zero dates and impossible dates give `undefined`.
 *
 * A time that occurs twice (the repeated hour when daylight saving ends, T04)
 * resolves to the later occurrence, as legacy PHP/Doctrine does. A time inside
 * the spring gap moves forward past the gap, which already equals legacy (T02).
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

  const earlier = osloWallClock({ day, hour, minute, month, second, year });
  const later = DateTime.add(earlier, { hours: 1 });
  const laterParts = osloParts(later);

  const repeated =
    laterParts.day === day &&
    laterParts.hour === hour &&
    laterParts.minute === minute &&
    laterParts.second === second;

  const instant = repeated ? later : earlier;
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

const isSemesterYear = Schema.is(SemesterYear);

const COORDINATE = /^-?\d+(?:\.\d+)?$/u;

const byLegacyPath = Order.mapInput(
  Order.String,
  (file: { readonly legacyPath: string }) => file.legacyPath
);

export const addEmptyTextReason = (
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

export const addReason = (
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

  const missing: (Omit<MissingFileReference, "file"> & {
    readonly path: string;
  })[] = [];

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

  /** One period per department and semester (spec 0009 UK1): a later one for the same pair is quarantined. */
  const repeatsAdmitted = (
    departmentId: AdmissionPeriodRow["departmentId"] | undefined,
    semesterId: AdmissionPeriodRow["semesterId"] | undefined
  ) =>
    departmentId !== undefined &&
    semesterId !== undefined &&
    Arr.some(
      admissionPeriods,
      (period) =>
        period.departmentId === departmentId && period.semesterId === semesterId
    );

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

    if (repeatsAdmitted(departmentId, semesterId)) {
      reasons.push(
        "the department already has an admitted admission period for this semester (UK1, spec 0009)"
      );
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
    rows: {
      admission_period: admissionPeriods,
      department: departments,
      field_of_study: fieldsOfStudy,
      public_file: publicFiles,
      semester: semesters,
      social_event: socialEvents,
    },
    rowsIn: {
      admission_period: snapshot.admissionPeriods.length,
      department: snapshot.departments.length,
      field_of_study: snapshot.fieldsOfStudy.length,
      public_file: new Set(referencedFilePaths(snapshot)).size,
      semester: snapshot.semesters.length,
      social_event: snapshot.socialEvents.length,
    },
  };
};
