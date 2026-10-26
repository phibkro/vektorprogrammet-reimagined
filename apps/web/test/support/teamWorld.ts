/**
 * A small world for the web tests of spec 0006: two departments with a field of study each, one team in each,
 * and people with memberships in every state the Membership machine knows. The tests run at 2026-10-15 (Høst 2026,
 * `OCTOBER_15`), so the terms below are relative to it.
 *
 * | person        | team (department)        | term                  | state at Høst 2026 |
 * | ------------- | ------------------------ | --------------------- | ------------------ |
 * | Lise Leder    | Rekruttering (Trondheim) | Vår 2025 – Høst 2026  | Active, ends now   |
 * | Mats Medlem   | Rekruttering (Trondheim) | Høst 2025 – Vår 2027  | Active             |
 * | Nora Neste    | Rekruttering (Trondheim) | Vår 2027 – Høst 2027  | Planned            |
 * | Eva Ekstern   | Rekruttering (Trondheim) | Vår 2024 – Vår 2025   | Ended              |
 * | Bjorn Bergen  | Rekruttering (Bergen)    | Høst 2025 – Vår 2027  | Active             |
 * | Ada Admin     | no team                  | admin place to 2099   |                    |
 */
import {
  AdminGrantId,
  DepartmentId,
  EmailAddress,
  FieldOfStudyId,
  MembershipId,
  PersonId,
  TeamId,
} from "@vektorprogrammet/domain";
import type {
  Membership,
  Person,
  Semester,
  Team,
} from "@vektorprogrammet/domain";
import {
  LEADER_POSITION,
  MEMBER_POSITION,
} from "@vektorprogrammet/domain/testing";
import { DateTime, Effect, Ref } from "effect";

import { fakeDepartment, fakeFieldOfStudy } from "./memory";
import type { MemoryTables } from "./memory";

export const TRONDHEIM = 1;

export const BERGEN = 2;

export const TRONDHEIM_TEAM = TeamId.make(1);

const BERGEN_TEAM = TeamId.make(2);

const FIELD_TRONDHEIM = 10;

const FIELD_BERGEN = 20;

/** The people, by the id their rows have. */
export const PEOPLE = {
  ada: PersonId.make(1),
  bjorn: PersonId.make(6),
  eva: PersonId.make(5),
  lise: PersonId.make(2),
  mats: PersonId.make(3),
  nora: PersonId.make(4),
} as const;

/** The memberships, by the id their rows have. */
export const MEMBERSHIPS = {
  bjorn: MembershipId.make(5),
  eva: MembershipId.make(4),
  lise: MembershipId.make(1),
  mats: MembershipId.make(2),
  nora: MembershipId.make(3),
} as const;

const person = (
  id: PersonId,
  name: string,
  fieldOfStudyId: number,
  departmentId: number
): Person => ({
  departmentId: DepartmentId.make(departmentId),
  email: EmailAddress.make(`${name.split(" ")[0]?.toLowerCase()}@example.org`),
  fieldOfStudyId: FieldOfStudyId.make(fieldOfStudyId),
  id,
  name,
});

const semester = (term: Semester["term"], year: number): Semester => ({
  term,
  year,
});

const membership = (
  id: MembershipId,
  personId: PersonId,
  teamId: TeamId,
  options: {
    readonly start: Semester;
    readonly end: Semester;
    readonly leader?: boolean;
  }
): Membership => ({
  end: options.end,
  id,
  leader: options.leader ?? false,
  personId,
  positionId: options.leader === true ? LEADER_POSITION : MEMBER_POSITION,
  start: options.start,
  teamId,
});

const team = (id: TeamId, departmentId: number): Team => ({
  active: true,
  defaultTerm: 2,
  departmentId: DepartmentId.make(departmentId),
  function: "recruitment",
  id,
  name: "Rekruttering",
});

/** Puts the world into `tables`: the departments and fields directly, the teams tables through their Refs. */
export const seedWorld = (tables: MemoryTables) => {
  tables.departments.push(
    fakeDepartment(TRONDHEIM, "Trondheim"),
    fakeDepartment(BERGEN, "Bergen")
  );
  tables.fieldsOfStudy.push(
    fakeFieldOfStudy(FIELD_TRONDHEIM, TRONDHEIM),
    fakeFieldOfStudy(FIELD_BERGEN, BERGEN)
  );

  return Effect.all(
    [
      Ref.set(tables.teams.people, [
        person(PEOPLE.ada, "Ada Admin", FIELD_TRONDHEIM, TRONDHEIM),
        person(PEOPLE.lise, "Lise Leder", FIELD_TRONDHEIM, TRONDHEIM),
        person(PEOPLE.mats, "Mats Medlem", FIELD_TRONDHEIM, TRONDHEIM),
        person(PEOPLE.nora, "Nora Neste", FIELD_TRONDHEIM, TRONDHEIM),
        person(PEOPLE.eva, "Eva Ekstern", FIELD_TRONDHEIM, TRONDHEIM),
        person(PEOPLE.bjorn, "Bjorn Bergen", FIELD_BERGEN, BERGEN),
      ]),
      Ref.set(tables.teams.teams, [
        team(TRONDHEIM_TEAM, TRONDHEIM),
        team(BERGEN_TEAM, BERGEN),
      ]),
      Ref.set(tables.teams.memberships, [
        membership(MEMBERSHIPS.lise, PEOPLE.lise, TRONDHEIM_TEAM, {
          end: semester("HOST", 2026),
          leader: true,
          start: semester("VAR", 2025),
        }),
        membership(MEMBERSHIPS.mats, PEOPLE.mats, TRONDHEIM_TEAM, {
          end: semester("VAR", 2027),
          start: semester("HOST", 2025),
        }),
        membership(MEMBERSHIPS.nora, PEOPLE.nora, TRONDHEIM_TEAM, {
          end: semester("HOST", 2027),
          start: semester("VAR", 2027),
        }),
        membership(MEMBERSHIPS.eva, PEOPLE.eva, TRONDHEIM_TEAM, {
          end: semester("VAR", 2025),
          start: semester("VAR", 2024),
        }),
        membership(MEMBERSHIPS.bjorn, PEOPLE.bjorn, BERGEN_TEAM, {
          end: semester("VAR", 2027),
          start: semester("HOST", 2025),
        }),
      ]),
      Ref.set(tables.teams.adminGrants, [
        {
          grantedBy: null,
          id: AdminGrantId.make(1),
          personId: PEOPLE.ada,
          until: DateTime.makeUnsafe("2099-12-31T23:59:59Z"),
        },
      ]),
    ],
    { discard: true }
  );
};
