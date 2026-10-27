/**
 * What a command about one person is about, for the grant table: a person belongs to the department of their field of
 * study and to the departments of their memberships (spec 0007, 0007b). Authorization depends on those facts, so the
 * person is locked first and the facts are read through the token (spec 0006b); the command then takes the held lock
 * again and finds it held.
 */
import { Array as Arr, Effect, Option } from "effect";

import type { Authorize } from "../kernel/authorize.ts";
import { CurrentPrincipal } from "../kernel/principal.ts";
import { AggregateLocks } from "../shared/aggregate.ts";
import type { PersonId } from "../shared/ids.ts";
import {
  MembershipRepository,
  PersonRepository,
  TeamRepository,
} from "./services.ts";

/**
 * The resource of `command` about `personId`: the first of the person's departments for which the principal holds
 * the command, or the department of their field of study when it holds none (so a refusal names a real department).
 */
export const personResource = Effect.fn("Teams.personResource")(
  function* personResource<Command extends string>(
    authorize: Authorize<Command>,
    command: Command,
    personId: PersonId
  ) {
    const people = yield* PersonRepository;
    const memberships = yield* MembershipRepository;
    const teams = yield* TeamRepository;
    const principal = yield* CurrentPrincipal;
    const locked = yield* (yield* AggregateLocks).lock("Person", personId);
    const person = yield* people.findLocked(locked);
    const membershipsOfPerson = yield* memberships.listLocked(locked);

    const departments = yield* Effect.forEach(
      membershipsOfPerson,
      (membership) =>
        Effect.map(
          teams.findById(membership.teamId),
          (team) => team.departmentId
        )
    );

    const resources = Arr.map(
      [person.departmentId, ...departments],
      (departmentId) => ({
        departmentId,
        personId,
      })
    );

    return Option.getOrElse(
      Arr.findFirst(resources, (resource) =>
        authorize(principal, command, resource)
      ),
      () => ({ departmentId: person.departmentId, personId })
    );
  }
);
