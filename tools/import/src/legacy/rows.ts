/**
 * Row shapes of the legacy MySQL tables the Phase 1 import reads.
 *
 * Structure source: the MySQL 5.7 structure-only dump of the 2024-08-22 backup;
 * its Phase 1 tables are vendored in `test/fixtures/legacy-phase1-schema.sql`. Column meaning: the legacy Doctrine entities in
 * `src/AppBundle/Entity/` (cited per table). The queries in `source.ts` alias
 * the columns to these camelCase names and select every `DATETIME` as
 * `YYYY-MM-DD HH:MM:SS` text, so no driver time-zone conversion happens: the
 * wall-clock text is interpreted in Europe/Oslo by the transform.
 */
import { Schema } from "effect";

const Id = Schema.Int;

const NullableId = Schema.NullOr(Schema.Int);

const NullableText = Schema.NullOr(Schema.String);

/** `tinyint(1)`: 0/1, read by mysql2 as a number. */
const TinyInt = Schema.Int;

/** `DATETIME` selected with `DATE_FORMAT(col, '%Y-%m-%d %H:%i:%s')`. */
const WallClock = Schema.String;

/** `department` (`Entity/Department.php`); `city` is unique in legacy too. */
export const LegacyDepartment = Schema.Struct({
  active: TinyInt,
  address: NullableText,
  city: Schema.String,
  email: Schema.String,
  id: Id,
  latitude: NullableText,
  logoPath: NullableText,
  longitude: NullableText,
  name: Schema.String,
  shortName: Schema.String,
  slackChannel: NullableText,
});

export type LegacyDepartment = typeof LegacyDepartment.Type;

/** `semester` (`Entity/Semester.php`): `semesterTime` is 'Vår' or 'Høst'; no unique key. */
export const LegacySemester = Schema.Struct({
  id: Id,
  semesterTime: Schema.String,
  year: Schema.String,
});

export type LegacySemester = typeof LegacySemester.Type;

/** `field_of_study` (`Entity/FieldOfStudy.php`): `department_id` is nullable in legacy. */
export const LegacyFieldOfStudy = Schema.Struct({
  departmentId: NullableId,
  id: Id,
  name: Schema.String,
  shortName: Schema.String,
});

export type LegacyFieldOfStudy = typeof LegacyFieldOfStudy.Type;

/** `AdmissionPeriod` (`Entity/AdmissionPeriod.php`); `infoMeeting_id` belongs to Phase 3. */
export const LegacyAdmissionPeriod = Schema.Struct({
  departmentId: NullableId,
  endDate: WallClock,
  id: Id,
  semesterId: NullableId,
  startDate: WallClock,
});

export type LegacyAdmissionPeriod = typeof LegacyAdmissionPeriod.Type;

/**
 * `article` (`Entity/Article.php`): `article` is the rich-text body; `published`
 * is nullable and legacy treats NULL as a draft (`isPublished()` is falsy);
 * `imageLarge`/`imageSmall` are web paths returned by `FileUploader`.
 */
export const LegacyArticle = Schema.Struct({
  authorId: NullableId,
  body: Schema.String,
  created: WallClock,
  id: Id,
  imageLarge: Schema.String,
  imageSmall: Schema.String,
  published: Schema.NullOr(TinyInt),
  slug: Schema.String,
  sticky: TinyInt,
  title: Schema.String,
});

export type LegacyArticle = typeof LegacyArticle.Type;

/** `articles_departments`: the article's department tags (none = all departments). */
export const LegacyArticleDepartment = Schema.Struct({
  articleId: Id,
  departmentId: Id,
});

export type LegacyArticleDepartment = typeof LegacyArticleDepartment.Type;

/** `static_content` (`Entity/StaticContent.php`): `html_id` is the block key; no unique key. */
export const LegacyStaticContent = Schema.Struct({
  html: Schema.String,
  htmlId: Schema.String,
  id: Id,
});

export type LegacyStaticContent = typeof LegacyStaticContent.Type;

/** `sponsor` (`Entity/Sponsor.php`): every column nullable; `size` is small/medium/large. */
export const LegacySponsor = Schema.Struct({
  id: Id,
  logoImagePath: NullableText,
  name: NullableText,
  size: NullableText,
  url: NullableText,
});

export type LegacySponsor = typeof LegacySponsor.Type;

/**
 * `event` (`Entity/SocialEvent.php`). `role_id` is not read: RULE-188 records
 * that the sign-up role was only displayed and never enforced, so it is dropped.
 */
export const LegacySocialEvent = Schema.Struct({
  departmentId: NullableId,
  description: Schema.String,
  endTime: WallClock,
  id: Id,
  link: NullableText,
  semesterId: NullableId,
  startTime: WallClock,
  title: Schema.String,
});

export type LegacySocialEvent = typeof LegacySocialEvent.Type;

/** Every Phase 1 legacy table, read in one consistent snapshot. */
export interface LegacySnapshot {
  readonly departments: readonly LegacyDepartment[];
  readonly semesters: readonly LegacySemester[];
  readonly fieldsOfStudy: readonly LegacyFieldOfStudy[];
  readonly admissionPeriods: readonly LegacyAdmissionPeriod[];
  readonly articles: readonly LegacyArticle[];
  readonly articleDepartments: readonly LegacyArticleDepartment[];
  readonly staticContents: readonly LegacyStaticContent[];
  readonly sponsors: readonly LegacySponsor[];
  readonly socialEvents: readonly LegacySocialEvent[];
}
