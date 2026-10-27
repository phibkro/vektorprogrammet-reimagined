/**
 * What the organisation domain declares about its stored columns (spec 0007b): departments, semesters, fields of
 * study and admission periods describe the organisation, not a person.
 */
import { columns, notPersonal, table } from "../personalData/declaration.ts";

const department = table({
  columns: columns(
    notPersonal(
      "A department's own details (its address, e-mail and Slack channel), published on the site for anyone who wants to contact it"
    ),
    [
      "active",
      "address",
      "city",
      "email",
      "id",
      "latitude",
      "logo_key",
      "longitude",
      "name",
      "short_name",
      "slack_channel",
    ]
  ),
  person: null,
});

const semester = table({
  columns: columns(notPersonal("A term of the calendar"), [
    "id",
    "term",
    "year",
  ]),
  person: null,
});

const fieldOfStudy = table({
  columns: columns(notPersonal("A course of study on a list"), [
    "department_id",
    "id",
    "name",
    "short_name",
  ]),
  person: null,
});

const admissionPeriod = table({
  columns: columns(
    notPersonal("The window in which a department takes applications"),
    ["department_id", "ends_at", "id", "semester_id", "starts_at"]
  ),
  person: null,
});

export const OrganisationTables = {
  admission_period: admissionPeriod,
  department,
  field_of_study: fieldOfStudy,
  semester,
} as const;
