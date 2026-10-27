/**
 * The entities of the teams domain (spec 0006, `docs/system/teams.md` § Entities): a person, a team with its
 * function and default term, an entry of the position value list, a membership with its term, and an admin grant.
 * Each has the schema the database rows decode with and the input schema a form posts.
 */
import { Schema, SchemaTransformation } from "effect";

import { TeamFunction } from "../kernel/principal.ts";
import { Semester } from "../organisation/semester.ts";
import {
  AdminGrantId,
  DepartmentId,
  FieldOfStudyId,
  MembershipId,
  PersonId,
  PositionId,
  TeamId,
} from "../shared/ids.ts";
import { EmailAddress, requiredText } from "../shared/validation.ts";

const NonBlank = Schema.String.check(Schema.isNonEmpty());

/** An e-mail address as a person has it: trimmed and lower case, so one address is one person. */
export const PersonEmailInput = Schema.Trim.pipe(
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.decodeTo(EmailAddress)
);

/**
 * One human known to Vektorprogrammet. `departmentId` is the department of the person's field of study: a member
 * belongs to the team's department (RULE-164).
 */
export const Person = Schema.Struct({
  companyEmail: Schema.optionalKey(Schema.NullOr(EmailAddress)),
  departmentId: DepartmentId,
  email: EmailAddress,
  fieldOfStudyId: FieldOfStudyId,
  id: PersonId,
  name: NonBlank,
});

export type Person = typeof Person.Type;

/** What a person is registered with. */
export const PersonDraft = Schema.Struct({
  companyEmail: Schema.optionalKey(Schema.NullOr(EmailAddress)),
  email: EmailAddress,
  fieldOfStudyId: FieldOfStudyId,
  name: NonBlank,
});

export type PersonDraft = typeof PersonDraft.Type;

/** The payload of `registerPerson`. */
export const PersonInput = Schema.Struct({
  companyEmail: Schema.optionalKey(Schema.NullOr(PersonEmailInput)),
  email: PersonEmailInput,
  fieldOfStudyId: FieldOfStudyId,
  name: requiredText({ maxLength: 250 }),
});

/** How many semesters a membership of a team lasts when nobody chooses (ADR 0002): the mode of the 2024 backup is 2. */
export const DefaultTerm = Schema.Literals([1, 2]);

export type DefaultTerm = typeof DefaultTerm.Type;

export const Team = Schema.Struct({
  active: Schema.Boolean,
  defaultTerm: DefaultTerm,
  departmentId: DepartmentId,
  function: TeamFunction,
  id: TeamId,
  name: NonBlank,
});

export type Team = typeof Team.Type;

export const TeamDraft = Schema.Struct({
  defaultTerm: DefaultTerm,
  departmentId: DepartmentId,
  function: TeamFunction,
  name: NonBlank,
});

export type TeamDraft = typeof TeamDraft.Type;

/** The fields of a team a leader can change; its department cannot move (RULE-321). */
export const TeamDetails = Schema.Struct({
  defaultTerm: DefaultTerm,
  function: TeamFunction,
  name: requiredText({ maxLength: 250 }),
});

export type TeamDetails = typeof TeamDetails.Type;

/** The value list a membership's position is chosen from. */
export const Position = Schema.Struct({ id: PositionId, name: NonBlank });

export type Position = typeof Position.Type;

/** A person's place in a team for a term. `end` is always set (ADR 0002). */
export const Membership = Schema.Struct({
  end: Semester,
  id: MembershipId,
  leader: Schema.Boolean,
  personId: PersonId,
  positionId: PositionId,
  start: Semester,
  teamId: TeamId,
});

export type Membership = typeof Membership.Type;

/** What a new membership is stored with. */
export const MembershipDraft = Schema.Struct({
  end: Semester,
  leader: Schema.Boolean,
  personId: PersonId,
  positionId: PositionId,
  start: Semester,
  teamId: TeamId,
});

export type MembershipDraft = typeof MembershipDraft.Type;

/**
 * A place on the admin list (`docs/system/administration.md`). `grantedBy` is the admin who gave it, or `null` for
 * the first place, which the operator gives outside the system. The place ends at `until`.
 */
export const AdminGrant = Schema.Struct({
  grantedBy: Schema.NullOr(PersonId),
  id: AdminGrantId,
  personId: PersonId,
  until: Schema.DateTimeUtc,
});

export type AdminGrant = typeof AdminGrant.Type;

export const AdminGrantDraft = Schema.Struct({
  grantedBy: Schema.NullOr(PersonId),
  personId: PersonId,
  until: Schema.DateTimeUtc,
});

export type AdminGrantDraft = typeof AdminGrantDraft.Type;
