/** Fake legacy rows for the importer's pure plans: an empty snapshot and a department builder. */
import type {
  LegacyDepartment,
  LegacySnapshot,
} from "../../src/legacy/rows.ts";

export const NO_ROWS: LegacySnapshot = {
  admissionPeriods: [],
  articleDepartments: [],
  articles: [],
  departments: [],
  fieldsOfStudy: [],
  semesters: [],
  socialEvents: [],
  sponsors: [],
  staticContents: [],
};

export const legacyDepartment = (
  id: number,
  city: string
): LegacyDepartment => ({
  active: 1,
  address: null,
  city,
  email: `kontakt${id}@example.org`,
  id,
  latitude: null,
  logoPath: null,
  longitude: null,
  name: `Avdeling ${id}`,
  shortName: `A${id}`,
  slackChannel: null,
});
