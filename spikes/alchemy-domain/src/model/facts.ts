/**
 * What a command is about, resolved before it is sent: the grant table is asked about a resource (the department of
 * the team, the person a membership belongs to), and `decide` needs a few facts that live in other rows. In the kernel
 * this is the `resource` function of each `Domain.handle`, a function of the payload and the repositories; here it is
 * one table from command to resolver, reading the SQL read models with SELECT only.
 *
 * Why it is a table and not part of the declaration: the kernel's declaration carries `Info` (resource and method), the
 * grants and the machines as data, and the `resource` function as code in the handler. A second runtime cannot reuse
 * code that sits inside a handler, so porting a command means spelling its resolver again (REPORT.md, patterns).
 */
import type { Command } from "@vektorprogrammet/domain";
import {
  DefaultTerm,
  DepartmentId,
  MembershipId,
  NotFound,
  PersonId,
  PositionId,
  TeamId,
} from "@vektorprogrammet/domain";
import { Effect, Record as Rec, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import type { Facts } from "./context.ts";

const TeamRow = Schema.Struct({
  active: Schema.Boolean,
  defaultTerm: DefaultTerm,
  departmentId: DepartmentId,
  id: TeamId,
});

const OwnerRow = Schema.Struct({
  departmentId: DepartmentId,
  personId: PersonId,
});

const PersonDepartmentRow = Schema.Struct({ departmentId: DepartmentId });

export const CommandPayloadSchema = Schema.Record(
  Schema.String,
  Schema.Unknown
);

export type CommandPayload = typeof CommandPayloadSchema.Type;

const none: Facts = { resources: [] };

const teamOf = Effect.fnUntraced(function* teamOf(teamId: TeamId) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly id: number;
    readonly departmentId: number;
    readonly active: boolean;
    readonly defaultTerm: DefaultTerm;
  }>`select id, department_id as "departmentId", active, default_term as "defaultTerm"
    from team where id = ${teamId}`.pipe(Effect.orDie);

  const [row] = rows;

  if (row === undefined) {
    return yield* new NotFound({ entity: "Team", key: String(teamId) });
  }

  return yield* Schema.decodeEffect(TeamRow)(row).pipe(Effect.orDie);
});

const personDepartmentOf = Effect.fnUntraced(function* personDepartmentOf(
  personId: PersonId
) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly departmentId: number;
  }>`select f.department_id as "departmentId"
    from person p join field_of_study f on f.id = p.field_of_study_id
    where p.id = ${personId}`.pipe(Effect.orDie);

  const [row] = rows;

  if (row === undefined) {
    return yield* new NotFound({ entity: "Person", key: String(personId) });
  }

  return (yield* Schema.decodeEffect(PersonDepartmentRow)(row).pipe(
    Effect.orDie
  )).departmentId;
});

const positionExists = Effect.fnUntraced(function* positionExists(
  positionId: PositionId
) {
  const sql = yield* SqlClient;

  const rows =
    yield* sql`select id from position where id = ${positionId}`.pipe(
      Effect.orDie
    );

  if (rows.length === 0) {
    return yield* new NotFound({ entity: "Position", key: String(positionId) });
  }

  return yield* Effect.void;
});

/** The owner and the department of a membership: what `Self` and a department scope are asked about. */
const ownerOf = Effect.fnUntraced(function* ownerOf(id: MembershipId) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly departmentId: number;
    readonly personId: number;
  }>`select m.person_id as "personId", t.department_id as "departmentId"
    from membership m join team t on t.id = m.team_id where m.id = ${id}`.pipe(
    Effect.orDie
  );

  const [row] = rows;

  if (row === undefined) {
    return yield* new NotFound({ entity: "Membership", key: String(id) });
  }

  return yield* Schema.decodeEffect(OwnerRow)(row).pipe(Effect.orDie);
});

const createMembershipFacts = Effect.fnUntraced(function* createMembershipFacts(
  payload: CommandPayload
) {
  const {
    target: personId,
    positionId,
    teamId,
  } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      positionId: PositionId,
      target: Schema.FiniteFromString.pipe(Schema.decodeTo(PersonId)),
      teamId: TeamId,
    })
  )(payload).pipe(Effect.orDie);

  const team = yield* teamOf(teamId);
  yield* positionExists(positionId);

  const personDepartmentId = yield* personDepartmentOf(personId);

  return {
    personDepartmentId,
    resources: [
      { departmentId: team.departmentId },
      { departmentId: personDepartmentId },
    ],
    team,
  } satisfies Facts;
});

const membershipFacts = Effect.fnUntraced(function* membershipFacts(
  payload: CommandPayload
) {
  const { membershipId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ membershipId: MembershipId })
  )(payload).pipe(Effect.orDie);

  const owner = yield* ownerOf(membershipId);

  return { resources: [owner] } satisfies Facts;
});

const accountCreationFacts = Effect.fnUntraced(function* accountCreationFacts(
  payload: CommandPayload
) {
  const { personId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ personId: PersonId })
  )(payload).pipe(Effect.orDie);

  const departmentId = yield* personDepartmentOf(personId);

  return { resources: [{ departmentId, personId }] } satisfies Facts;
});

const activationFacts = Effect.fnUntraced(function* activationFacts(
  payload: CommandPayload
) {
  const { personId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ personId: PersonId })
  )(payload).pipe(Effect.orDie);

  return { resources: [{ personId }] } satisfies Facts;
});

/**
 * The resolver of each command that the model hosts. A command of a job or a policy has none: it is granted to a
 * `System` principal and is about no resource.
 */
type FactResolver = (
  payload: CommandPayload
) => Effect.Effect<Facts, NotFound, SqlClient>;

const resolverMap = {
  activateAccount: activationFacts,
  createAccount: accountCreationFacts,
  createAdminGrant: () => Effect.succeed(none),
  createMembership: createMembershipFacts,
  deactivateAccount: () => Effect.succeed(none),
  deleteAdminGrant: () => Effect.succeed(none),
  deleteMembership: membershipFacts,
  endEarlyMembership: membershipFacts,
  extendMembership: membershipFacts,
  reactivateAccount: () => Effect.succeed(none),
} satisfies Partial<Record<Command, FactResolver>>;

export type HostedCommand = keyof typeof resolverMap;

export const resolvers: Readonly<typeof resolverMap> = resolverMap;

/** The facts of a command: its resolver, from the hosted command set. */
export const factsOf = (
  command: HostedCommand,
  payload: CommandPayload
): Effect.Effect<Facts, NotFound, SqlClient> => resolvers[command](payload);

/** The resolver key set is the command allowlist used by the model API. */
export const isHostedCommand = (command: string): command is HostedCommand => {
  for (const candidate of Rec.keys(resolverMap)) {
    if (candidate === command) {
      return true;
    }
  }

  return false;
};
