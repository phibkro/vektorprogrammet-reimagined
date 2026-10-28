import type { TargetRows } from "@vektorprogrammet/domain";

/** An import plan with no rows: `replaceAll` of it truncates what it owns and inserts nothing. */
export const noRows: TargetRows = {
  admission_period: [],
  department: [],
  field_of_study: [],
  public_file: [],
  semester: [],
  social_event: [],
};
