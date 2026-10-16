/**
 * Branded identifiers and the closed set of entity names.
 *
 * Integer ids mirror PostgreSQL identity columns; legacy department ids are kept
 * by the importer. File keys are content-addressed (SHA-256 of the bytes plus an
 * extension derived from the detected content type, see `files/fileType.ts`).
 */
import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const DepartmentId = PositiveInt.pipe(Schema.brand("DepartmentId"));

export type DepartmentId = typeof DepartmentId.Type;

export const SemesterId = PositiveInt.pipe(Schema.brand("SemesterId"));

export type SemesterId = typeof SemesterId.Type;

export const FieldOfStudyId = PositiveInt.pipe(Schema.brand("FieldOfStudyId"));

export type FieldOfStudyId = typeof FieldOfStudyId.Type;

export const SocialEventId = PositiveInt.pipe(Schema.brand("SocialEventId"));

export type SocialEventId = typeof SocialEventId.Type;

/** A user id. Phase 1 has no user table; it carries the legacy user id (Phase 2 adds the foreign key). */
export const UserId = PositiveInt.pipe(Schema.brand("UserId"));

export type UserId = typeof UserId.Type;

/** Outbox row id, chosen by `packages/db`. */
export const OutboxMessageId = Schema.NonEmptyString.pipe(
  Schema.brand("OutboxMessageId")
);

export type OutboxMessageId = typeof OutboxMessageId.Type;

/** File extensions a content-addressed key may end with; one per stored content type. */
export const FileExtension = Schema.Literals([
  "jpg",
  "png",
  "webp",
  "gif",
  "pdf",
  "bin",
]);

export type FileExtension = typeof FileExtension.Type;

/** Content-addressed R2 object key: `<sha256 hex>.<extension>`. Immutable once written. */
export const FileKey = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}\.(?<extension>jpg|png|webp|gif|pdf|bin)$/u, {
    expected: "a content-addressed file key",
  })
).pipe(Schema.brand("FileKey"));

export type FileKey = typeof FileKey.Type;

/** Every aggregate the domain names in errors and audit entries. */
export const EntityName = Schema.Literals([
  "Department",
  "Semester",
  "FieldOfStudy",
  "Article",
  "SocialEvent",
  "PublicFile",
]);

export type EntityName = typeof EntityName.Type;
