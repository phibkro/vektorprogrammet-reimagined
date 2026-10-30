import { Teams } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import {
  Text,
  blankToNull,
  formSchema,
  isChecked,
  osloLocalToIso,
  wholeNumber,
} from "./formSchema";
import { optionalSemesterOfChoice, semesterOfChoice } from "./semester";

/** The fields that a team is made and changed with; a blank `id` makes a new team (in `departmentId`), an `id` changes one. */
const TeamStrings = {
  defaultTerm: Text,
  departmentId: Text,
  function: Text,
  groupEmail: Text,
  id: Text,
  name: Text,
};

const teamDetails = (text: Readonly<Record<string, string | undefined>>) => ({
  defaultTerm: wholeNumber(text.defaultTerm),
  function: text.function ?? "",
  groupEmail: blankToNull(text.groupEmail),
  name: text.name ?? "",
});

/** A new team in a department. */
export const CreateTeamForm = formSchema(
  Schema.Struct(TeamStrings),
  Teams.createTeam.payloadSchema,
  (text) => ({
    ...teamDetails(text),
    departmentId: wholeNumber(text.departmentId),
  })
);

/** A team that is changed. */
export const UpdateTeamForm = formSchema(
  Schema.Struct(TeamStrings),
  Teams.updateTeam.payloadSchema,
  (text) => ({ ...teamDetails(text), id: wholeNumber(text.id) })
);

/** A team that is no longer used. */
export const DeactivateTeamForm = formSchema(
  Schema.Struct({ id: Text }),
  Teams.deactivateTeam.payloadSchema,
  (text) => ({ id: wholeNumber(text.id) })
);

/** A person who is registered, with the field of study that gives them a department. */
export const RegisterPersonForm = formSchema(
  Schema.Struct({
    companyEmail: Text,
    email: Text,
    fieldOfStudyId: Text,
    name: Text,
  }),
  Teams.createPerson.payloadSchema,
  (text) => ({
    companyEmail: blankToNull(text.companyEmail),
    email: text.email ?? "",
    fieldOfStudyId: wholeNumber(text.fieldOfStudyId),
    name: text.name ?? "",
  })
);

/** A person who is added to a team; a blank `end` takes the team's default term. */
export const AddMemberForm = formSchema(
  Schema.Struct({
    end: Text,
    leader: Text,
    personId: Text,
    positionId: Text,
    start: Text,
    teamId: Text,
  }),
  Teams.createMembership.payloadSchema,
  (text) => {
    const member = {
      leader: isChecked(text.leader),
      personId: wholeNumber(text.personId),
      positionId: wholeNumber(text.positionId),
      start: semesterOfChoice(text.start),
      teamId: wholeNumber(text.teamId),
    };

    const end = optionalSemesterOfChoice(text.end);

    return end === null ? member : { ...member, end };
  }
);

/** A membership that is extended to a later semester. */
export const ExtendMembershipForm = formSchema(
  Schema.Struct({ end: Text, id: Text }),
  Teams.extendMembership.payloadSchema,
  (text) => ({
    end: semesterOfChoice(text.end),
    id: wholeNumber(text.id),
  })
);

/** A membership whose position or leader flag changes from a semester. */
export const ChangeMembershipForm = formSchema(
  Schema.Struct({ from: Text, id: Text, leader: Text, positionId: Text }),
  Teams.changeMembership.payloadSchema,
  (text) => ({
    from: semesterOfChoice(text.from),
    id: wholeNumber(text.id),
    leader: isChecked(text.leader),
    positionId: wholeNumber(text.positionId),
  })
);

/** A membership that ends before a semester. */
export const EndMembershipForm = formSchema(
  Schema.Struct({ id: Text, semester: Text }),
  Teams.endEarlyMembership.payloadSchema,
  (text) => ({
    id: wholeNumber(text.id),
    semester: semesterOfChoice(text.semester),
  })
);

/** A membership that is removed. */
export const CancelMembershipForm = formSchema(
  Schema.Struct({ id: Text }),
  Teams.deleteMembership.payloadSchema,
  (text) => ({ id: wholeNumber(text.id) })
);

/** An administrator place for a person until a time (Oslo wall-clock time). */
export const GrantAdminForm = formSchema(
  Schema.Struct({ personId: Text, until: Text }),
  Teams.createAdminGrant.payloadSchema,
  (text) => ({
    personId: wholeNumber(text.personId),
    until: osloLocalToIso(text.until),
  })
);

/** An administrator place that is taken away. */
export const RevokeAdminForm = formSchema(
  Schema.Struct({ id: Text }),
  Teams.deleteAdminGrant.payloadSchema,
  (text) => ({ id: wholeNumber(text.id) })
);
