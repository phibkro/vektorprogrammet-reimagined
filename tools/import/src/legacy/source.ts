/**
 * The legacy MySQL source. Reads the Phase 1 tables through the SELECT-only
 * `legacy_reader` user (architecture critique m6) in one read-only transaction,
 * so every table comes from the same InnoDB snapshot. Rows are ordered by
 * primary key: the pipeline is deterministic from here on.
 */
import { MysqlClient } from "@effect/sql-mysql2";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  LegacyAdmissionPeriod,
  LegacyArticle,
  LegacyArticleDepartment,
  LegacyDepartment,
  LegacyFieldOfStudy,
  LegacySemester,
  LegacySocialEvent,
  LegacySponsor,
  LegacyStaticContent,
  type LegacySnapshot,
} from "./rows.ts";

export class LegacySourceError extends Schema.TaggedError<LegacySourceError>()(
  "LegacySourceError",
  { table: Schema.String, cause: Schema.Defect() },
) {}

export class LegacySource extends Context.Service<
  LegacySource,
  { readonly snapshot: Effect.Effect<LegacySnapshot, LegacySourceError> }
>()("@vektorprogrammet/import/LegacySource") {
  /** Reads from the ambient `MysqlClient`. */
  static readonly layer = Layer.effect(
    LegacySource,
    Effect.gen(function* () {
      const sql = yield* MysqlClient.MysqlClient;

      const read = <A>(
        table: string,
        row: Schema.Codec<A, unknown>,
        query: Effect.Effect<ReadonlyArray<unknown>, unknown>,
      ): Effect.Effect<ReadonlyArray<A>, LegacySourceError> =>
        query.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))),
          Effect.mapError((cause) => new LegacySourceError({ table, cause })),
        );

      const snapshot = Effect.all({
        departments: read(
          "department",
          LegacyDepartment,
          sql`SELECT id, name, short_name AS shortName, email, address, city,
                     slackChannel AS slackChannel, logo_path AS logoPath,
                     latitude, longitude, active
              FROM department ORDER BY id`,
        ),
        semesters: read(
          "semester",
          LegacySemester,
          sql`SELECT id, semesterTime AS semesterTime, year FROM semester ORDER BY id`,
        ),
        fieldsOfStudy: read(
          "field_of_study",
          LegacyFieldOfStudy,
          sql`SELECT id, department_id AS departmentId, name, short_name AS shortName
              FROM field_of_study ORDER BY id`,
        ),
        admissionPeriods: read(
          "AdmissionPeriod",
          LegacyAdmissionPeriod,
          sql`SELECT id, department_id AS departmentId, semester_id AS semesterId,
                     DATE_FORMAT(start_date, '%Y-%m-%d %H:%i:%s') AS startDate,
                     DATE_FORMAT(end_date, '%Y-%m-%d %H:%i:%s') AS endDate
              FROM AdmissionPeriod ORDER BY id`,
        ),
        articles: read(
          "article",
          LegacyArticle,
          sql`SELECT id, author_id AS authorId, title, article AS body,
                     imageLarge AS imageLarge, imageSmall AS imageSmall,
                     DATE_FORMAT(created, '%Y-%m-%d %H:%i:%s') AS created,
                     sticky, published, slug
              FROM article ORDER BY id`,
        ),
        articleDepartments: read(
          "articles_departments",
          LegacyArticleDepartment,
          sql`SELECT article_id AS articleId, department_id AS departmentId
              FROM articles_departments ORDER BY article_id, department_id`,
        ),
        staticContents: read(
          "static_content",
          LegacyStaticContent,
          sql`SELECT id, html_id AS htmlId, html FROM static_content ORDER BY id`,
        ),
        sponsors: read(
          "sponsor",
          LegacySponsor,
          sql`SELECT id, name, url, logoImagePath AS logoImagePath, size FROM sponsor ORDER BY id`,
        ),
        socialEvents: read(
          "event",
          LegacySocialEvent,
          sql`SELECT id, department_id AS departmentId, semester_id AS semesterId, title,
                     description,
                     DATE_FORMAT(startTime, '%Y-%m-%d %H:%i:%s') AS startTime,
                     DATE_FORMAT(endTime, '%Y-%m-%d %H:%i:%s') AS endTime,
                     link
              FROM event ORDER BY id`,
        ),
      }).pipe(
        sql.withTransaction,
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new LegacySourceError({ table: "(transaction)", cause })),
        ),
        Effect.withSpan("LegacySource.snapshot"),
      );

      return LegacySource.of({ snapshot });
    }),
  );
}

/** The MySQL client for the source, from a `mysql://` URL. */
export const legacyMysqlLayer = (url: Redacted.Redacted<string>) =>
  MysqlClient.layer({ url, maxConnections: 2 });
