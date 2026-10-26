/**
 * `/kontrollpanel/team`, `/personer` and `/administratorer` (spec 0006): view programs over the teams repositories and
 * the command programs a server function runs. A page's controls ask the grant table (`authorize`) and the Membership
 * machine (`Machine.startsFrom`), the two that the commands themselves obey, so a control the principal may not use,
 * or that the membership's state does not offer, is not rendered (ADR 0001, ADR 0007). The domain decodes and
 * validates every input through the command's payload schema; this module only turns form text into its shapes.
 */
import {
  AdminGrantRepository,
  CurrentPrincipal,
  DepartmentRepository,
  FieldOfStudyRepository,
  Machine,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  Teams,
  TeamsEndpoints,
  TeamRepository,
  advanceSemester,
  authorize,
  currentSemester,
  decodeInput,
  membershipState,
  semesterLabel,
  semesterOfOrdinal,
  semesterOrdinal,
  TeamId,
} from "@vektorprogrammet/domain";
import type {
  Department,
  DepartmentId,
  Membership,
  Principal,
  Semester,
  Team,
  MembershipState,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
} from "effect";

import {
  SAVED,
  checkbox,
  integer,
  optionalText,
  osloLocalToIso,
  text,
} from "./panel";

// ---------------------------------------------------------------- semesters in forms

/** A semester in a `<select>`: `HOST-2026` is what the form posts, and what `semesterOfChoice` reads back. */
export interface SemesterChoice {
  readonly value: string;
  readonly label: string;
}

const choiceOf = (semester: Semester): SemesterChoice => ({
  label: semesterLabel(semester),
  value: `${semester.term}-${semester.year}`,
});

/** The semesters from `first` to `last`, both included; none when `last` is before `first`. */
const choicesBetween = (
  first: Semester,
  last: Semester
): readonly SemesterChoice[] =>
  semesterOrdinal(first) > semesterOrdinal(last)
    ? []
    : Arr.map(
        Arr.range(semesterOrdinal(first), semesterOrdinal(last)),
        (ordinal) => choiceOf(semesterOfOrdinal(ordinal))
      );

const later = (left: Semester, right: Semester): Semester =>
  semesterOrdinal(left) >= semesterOrdinal(right) ? left : right;

const SEMESTER_VALUE = /^(?<term>VAR|HOST)-(?<year>\d{4})$/u;

/** `HOST-2026` → the semester; anything else passes through so the domain reports it. */
export const semesterOfChoice = (raw: string) => {
  const [, term, year] = SEMESTER_VALUE.exec(raw) ?? [];

  return term === undefined || year === undefined
    ? raw
    : { term, year: Number(year) };
};

// ---------------------------------------------------------------- teams

const byName = Order.mapInput(
  Order.String,
  (row: { readonly name: string }) => row.name
);

const departmentNames = DepartmentRepository.use(
  (departments) => departments.list
);

const nameOfDepartment = (
  departments: readonly Department[],
  id: DepartmentId
): string =>
  Option.match(
    Arr.findFirst(departments, (department) => department.id === id),
    { onNone: () => `Avdeling ${id}`, onSome: (department) => department.name }
  );

/** The teams the principal may see, and the departments it may create one in. */
export const teamsView = Effect.gen(function* teamsView() {
  const principal = yield* CurrentPrincipal;
  const teams = yield* (yield* TeamRepository).list(null);
  const departments = yield* departmentNames;

  const creatable = Arr.filter(departments, (department) =>
    authorize(principal, "createTeam", { departmentId: department.id })
  );

  return {
    canCreate: creatable.length > 0,
    departments: Arr.map(creatable, (department) => ({
      id: department.id,
      name: department.name,
    })),
    teams: Arr.map(
      Arr.filter(teams, (team) =>
        authorize(principal, "viewTeams", { departmentId: team.departmentId })
      ),
      (team) => ({
        active: team.active,
        defaultTerm: team.defaultTerm,
        departmentName: nameOfDepartment(departments, team.departmentId),
        function: team.function,
        id: team.id,
        name: team.name,
      })
    ),
  };
});

type MembershipCommand = "cancel" | "change" | "endEarly" | "extend";

/** One membership row of a team page: the term, the calculated state, and the controls it offers. */
export interface MemberRow {
  readonly canCancel: boolean;
  readonly canChange: boolean;
  readonly canEnd: boolean;
  readonly canExtend: boolean;
  readonly changeChoices: readonly SemesterChoice[];
  readonly end: SemesterChoice;
  readonly endChoices: readonly SemesterChoice[];
  readonly extendChoices: readonly SemesterChoice[];
  readonly id: number;
  readonly leader: boolean;
  readonly personId: number;
  readonly personName: string;
  readonly positionId: number;
  readonly positionName: string;
  readonly start: SemesterChoice;
  readonly state: MembershipState;
}

const memberRow = (
  principal: Principal,
  team: Pick<Team, "departmentId">,
  current: Semester,
  member: Membership & {
    readonly personName: string;
    readonly positionName: string;
  }
): MemberRow => {
  const state = membershipState(member, current);

  const may = (command: MembershipCommand) =>
    authorize(principal, command, {
      departmentId: team.departmentId,
      personId: member.personId,
    }) && Machine.startsFrom(Teams.MembershipMachine, command, state);

  const endings = choicesBetween(
    later(advanceSemester(member.start, 1), current),
    member.end
  );

  return {
    canCancel: may("cancel"),
    canChange: may("change"),
    canEnd: may("endEarly"),
    canExtend: may("extend"),
    changeChoices: endings,
    end: choiceOf(member.end),
    endChoices: endings,
    extendChoices: choicesBetween(
      advanceSemester(member.end, 1),
      advanceSemester(member.end, 6)
    ),
    id: member.id,
    leader: member.leader,
    personId: member.personId,
    personName: member.personName,
    positionId: member.positionId,
    positionName: member.positionName,
    start: choiceOf(member.start),
    state,
  };
};

const decodeTeamId = decodeInput(TeamId);

/** One team and its memberships, ended ones included (history shows both rows of a change). */
export const teamView = Effect.fnUntraced(function* teamView(id: number) {
  const principal = yield* CurrentPrincipal;
  const teamId = yield* decodeTeamId(id);
  const team = yield* (yield* TeamRepository).findById(teamId);
  const departments = yield* departmentNames;
  const current = yield* currentSemester;
  const { departmentId } = team;

  yield* Teams.TeamsDomain.requireGrant("viewTeams", { departmentId });

  const members = yield* (yield* MembershipRepository).listByTeam(team.id);
  const canAdd = authorize(principal, "addMember", { departmentId });
  const positions = yield* (yield* PositionRepository).list;

  const people = canAdd
    ? yield* (yield* PersonRepository).list(departmentId)
    : [];

  return {
    canAdd,
    canDeactivate: authorize(principal, "deactivateTeam", { departmentId }),
    canEdit: authorize(principal, "editTeam", { departmentId }),
    current: semesterLabel(current),
    members: Arr.map(members, (member) =>
      memberRow(principal, team, current, member)
    ),
    people: Arr.map(people, (person) => ({ id: person.id, name: person.name })),
    positions: Arr.map(positions, (position) => ({
      id: position.id,
      name: position.name,
    })),
    semesters: choicesBetween(current, advanceSemester(current, 8)),
    team: {
      active: team.active,
      defaultTerm: team.defaultTerm,
      departmentName: nameOfDepartment(departments, departmentId),
      function: team.function,
      id: team.id,
      name: team.name,
    },
  };
});

// ---------------------------------------------------------------- people

/** The people the principal may see, and the fields of study it may register a new person with. */
export const peopleView = Effect.gen(function* peopleView() {
  const principal = yield* CurrentPrincipal;
  const people = yield* (yield* PersonRepository).list(null);
  const departments = yield* departmentNames;
  const fieldsOfStudy = yield* FieldOfStudyRepository;

  const registrable = Arr.filter(departments, (department) =>
    authorize(principal, "registerPerson", { departmentId: department.id })
  );

  const fields = yield* Effect.forEach(registrable, (department) =>
    Effect.map(fieldsOfStudy.listByDepartment(department.id), (found) =>
      Arr.map(found, (field) => ({
        id: field.id,
        label: `${department.name}: ${field.name}`,
      }))
    )
  );

  return {
    canRegister: registrable.length > 0,
    fieldsOfStudy: Arr.flatten(fields),
    people: Arr.map(
      Arr.filter(people, (person) =>
        authorize(principal, "viewPeople", {
          departmentId: person.departmentId,
        })
      ),
      (person) => ({
        departmentName: nameOfDepartment(departments, person.departmentId),
        email: person.email,
        id: person.id,
        name: person.name,
      })
    ),
  };
});

// ---------------------------------------------------------------- the admin list

/** The admin list, for a principal that may change it; anyone else is `Forbidden`. */
export const adminsView = Effect.gen(function* adminsView() {
  yield* Teams.TeamsDomain.requireGrant("grantAdmin", {});
  const principal = yield* CurrentPrincipal;
  const now = yield* DateTime.now;
  const grants = yield* (yield* AdminGrantRepository).list;
  const people = yield* (yield* PersonRepository).list(null);

  const self = Predicate.isTagged(principal, "Person")
    ? principal.personId
    : null;

  return {
    candidates: Arr.map(Arr.sort(people, byName), (person) => ({
      id: person.id,
      name: person.name,
    })),
    grants: Arr.map(grants, (grant) => ({
      id: grant.id,
      own: grant.personId === self,
      personName: grant.personName,
      until: DateTime.formatIsoDateUtc(grant.until),
      valid: DateTime.isGreaterThan(grant.until, now),
    })),
  };
});

// ---------------------------------------------------------------- commands

const answered = <A, E, R>(command: Effect.Effect<A, E, R>) =>
  Effect.as(command, SAVED);

/** A blank `id` creates a team in the named department, an `id` changes the team. */
export const saveTeamProgram = (form: FormData) => {
  const id = text(form, "id");

  const details = {
    defaultTerm: integer(text(form, "defaultTerm")),
    function: text(form, "function"),
    name: text(form, "name"),
  };

  return answered(
    id === ""
      ? TeamsEndpoints.createTeam({
          ...details,
          departmentId: integer(text(form, "departmentId")),
        })
      : TeamsEndpoints.editTeam({ ...details, id: integer(id) })
  );
};

export const deactivateTeamProgram = (form: FormData) =>
  answered(TeamsEndpoints.deactivateTeam({ id: integer(text(form, "id")) }));

export const registerPersonProgram = (form: FormData) =>
  answered(
    TeamsEndpoints.registerPerson({
      email: text(form, "email"),
      fieldOfStudyId: integer(text(form, "fieldOfStudyId")),
      name: text(form, "name"),
    })
  );

/** The end semester is optional: blank takes the team's default term. */
export const addMemberProgram = (form: FormData) => {
  const end = optionalText(form, "end");

  const input = {
    leader: checkbox(form, "leader"),
    personId: integer(text(form, "personId")),
    positionId: integer(text(form, "positionId")),
    start: semesterOfChoice(text(form, "start")),
    teamId: integer(text(form, "teamId")),
  };

  return answered(
    TeamsEndpoints.addMember(
      end === null ? input : { ...input, end: semesterOfChoice(end) }
    )
  );
};

export const extendProgram = (form: FormData) =>
  answered(
    TeamsEndpoints.extend({
      end: semesterOfChoice(text(form, "end")),
      id: integer(text(form, "id")),
    })
  );

export const changeProgram = (form: FormData) =>
  answered(
    TeamsEndpoints.change({
      from: semesterOfChoice(text(form, "from")),
      id: integer(text(form, "id")),
      leader: checkbox(form, "leader"),
      positionId: integer(text(form, "positionId")),
    })
  );

export const endProgram = (form: FormData) =>
  answered(
    TeamsEndpoints.endEarly({
      id: integer(text(form, "id")),
      semester: semesterOfChoice(text(form, "semester")),
    })
  );

export const cancelProgram = (form: FormData) =>
  answered(TeamsEndpoints.cancel({ id: integer(text(form, "id")) }));

export const grantAdminProgram = (form: FormData) =>
  answered(
    TeamsEndpoints.grantAdmin({
      personId: integer(text(form, "personId")),
      until: osloLocalToIso(text(form, "until")),
    })
  );

export const revokeAdminProgram = (form: FormData) =>
  answered(TeamsEndpoints.revokeAdmin({ id: integer(text(form, "id")) }));
