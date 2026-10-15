/** C1 fields of study (linjer). Every field of study belongs to exactly one department. */
import { Schema } from "effect";
import { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import { requiredText } from "../shared/validation.ts";

const NonBlank = Schema.String.check(Schema.isNonEmpty());

export const FieldOfStudy = Schema.Struct({
  id: FieldOfStudyId,
  departmentId: DepartmentId,
  name: NonBlank,
  shortName: NonBlank,
});
export type FieldOfStudy = typeof FieldOfStudy.Type;

export const FieldOfStudyDraft = Schema.Struct({
  departmentId: DepartmentId,
  name: NonBlank,
  shortName: NonBlank,
});
export type FieldOfStudyDraft = typeof FieldOfStudyDraft.Type;

/** Form input for create. `departmentId` defaults to the actor's own department (RULE-139). */
export const FieldOfStudyInput = Schema.Struct({
  departmentId: Schema.optionalKey(DepartmentId),
  name: requiredText({ maxLength: 250 }),
  shortName: requiredText({ maxLength: 50 }),
});
export type FieldOfStudyInput = typeof FieldOfStudyInput.Type;

/** Form input for rename. */
export const FieldOfStudyRename = Schema.Struct({
  name: requiredText({ maxLength: 250 }),
  shortName: requiredText({ maxLength: 50 }),
});
export type FieldOfStudyRename = typeof FieldOfStudyRename.Type;
