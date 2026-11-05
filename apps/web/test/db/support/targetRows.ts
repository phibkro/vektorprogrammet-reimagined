import type { TargetRows } from "../../../src/features/organisation/domain/legacyImport";

/** An import plan with no rows: `replaceAll` of it truncates what it owns and inserts nothing. */
export const noRows: TargetRows = {
  admission_period: [],
  department: [],
  field_of_study: [],
  public_file: [],
  semester: [],
  social_event: [],
};
