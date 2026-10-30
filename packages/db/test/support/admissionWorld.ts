/**
 * What the admission tests of spec 0009 share: a department with a field of study, a recruitment team and a leader, a
 * stored semester, the principals that act, and the encoded input of an application. Every value is a fake of the same
 * shape; every name carries `tag`, so tests that share one database never collide.
 */
import {
  AdmissionEndpoints,
  PersonId,
  Principal,
  SemesterRepository,
  TeamId,
} from "@vektorprogrammet/domain";
import type {
  AdmissionPeriodId,
  ApplicationDraft,
  DepartmentId as DepartmentIdType,
  Semester,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { runAs } from "./personalDataActors.ts";
import { world } from "./teamsWorld.ts";

/** The semester that the world's periods are for. */
const SPRING: Semester = { term: "VAR", year: 2027 };

/** The start and the end of a period that is open on 2027-03-01 and over on 2027-04-01. */
export const OPENS = DateTime.makeUnsafe("2027-02-01T08:00:00Z");

export const CLOSES = DateTime.makeUnsafe("2027-03-31T22:00:00Z");

/** A department, its field of study and recruitment team, a person, and the stored semester `SPRING`. */
export const arrange = Effect.fnUntraced(function* arrange(tag: string) {
  const fixture = yield* world(tag);

  yield* (yield* SemesterRepository).ensure(SPRING);

  return fixture;
});

/** A leader of a team of `departmentId`: the principal that schedules, registers and withdraws there. */
export const leaderOf = (departmentId: DepartmentIdType, personId: number) =>
  Principal.cases.Person.make({
    memberships: [
      {
        departmentId,
        function: "recruitment",
        leader: true,
        teamId: TeamId.make(1),
      },
    ],
    personId: PersonId.make(personId),
  });

/** A member of a team of another function: the principal that reads nothing of admission. */
export const outsiderOf = (departmentId: DepartmentIdType, personId: number) =>
  Principal.cases.Person.make({
    memberships: [
      {
        departmentId,
        function: "board",
        leader: false,
        teamId: TeamId.make(2),
      },
    ],
    personId: PersonId.make(personId),
  });

/** The encoded input of a period (what a form posts). */
export const periodInput = (
  departmentId: DepartmentIdType,
  start: DateTime.Utc = OPENS,
  end: DateTime.Utc = CLOSES
) => ({
  departmentId,
  end: DateTime.formatIso(end),
  semester: SPRING,
  start: DateTime.formatIso(start),
});

/** `principal` schedules a period; it answers the stored period. */
export const schedule = (
  principal: Principal,
  input: ReturnType<typeof periodInput>
) => runAs(principal, AdmissionEndpoints.createAdmissionPeriod(input));

/** The encoded answers of an applicant, as a form posts them. */
export interface ApplicationAnswers {
  readonly bolk: string;
  readonly departmentId: number;
  readonly doublePosition: boolean;
  readonly email: string;
  readonly fieldOfStudyId: number;
  readonly gender: string | null;
  readonly heardAbout: readonly string[];
  readonly name: string;
  readonly specialNeeds: string | null;
  readonly specialNeedsConsent: boolean;
  readonly teamInterest: readonly number[];
  readonly weekdays: readonly string[];
  readonly yearOfStudy: number;
}

/** The encoded answers of an applicant of `departmentId`, over the field of study `fieldOfStudyId`. */
export const applicationInput = (
  departmentId: DepartmentIdType,
  fieldOfStudyId: number,
  email: string,
  changes: Partial<ApplicationAnswers> = {}
): ApplicationAnswers => ({
  bolk: "Both",
  departmentId,
  doublePosition: false,
  email,
  fieldOfStudyId,
  gender: null,
  heardAbout: ["Web"],
  name: `Søker ${email}`,
  specialNeeds: null,
  specialNeedsConsent: false,
  teamInterest: [],
  weekdays: ["Monday", "Tuesday"],
  yearOfStudy: 2,
  ...changes,
});

/** How many rows of `table` there are. */
export const count = Effect.fnUntraced(function* count(table: string) {
  const sql = yield* SqlClient;

  const [row] = yield* sql.unsafe<{ n: number }>(
    `select count(*)::int as n from ${table}`
  );

  return row?.n ?? 0;
});

/** The messages that the outbox holds, by kind. */
export const outboxKinds = Effect.fnUntraced(function* outboxKinds() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    kind: string;
  }>`select kind from outbox order by id`;

  return Arr.map(rows, (row) => row.kind);
});

/** An application as a fixture writes it outside a command (one weekday, no gender), with the given stored special needs. */
export const applicationDraft = (
  fieldOfStudyId: ApplicationDraft["fieldOfStudyId"],
  periodId: AdmissionPeriodId,
  specialNeeds: ApplicationDraft["specialNeeds"] = null
): ApplicationDraft => ({
  bolk: "Both",
  doublePosition: false,
  fieldOfStudyId,
  gender: null,
  heardAbout: [],
  periodId,
  specialNeeds,
  teamInterest: [],
  weekdays: ["Monday"],
  yearOfStudy: 1,
});
