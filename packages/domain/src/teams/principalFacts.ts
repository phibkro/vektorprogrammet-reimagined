/**
 * How the facts that a repository read become a person's principal (spec 0006): the memberships active this semester,
 * and the latest end among the admin places that are still valid at `now`. `PrincipalDirectory` implementations load
 * the rows in one read and call this, so every deployment and every test builds a principal one way.
 */
import { Array as Arr, DateTime, Option } from "effect";

import { Principal } from "../kernel/principal.ts";
import type { MembershipFact, PersonPrincipal } from "../kernel/principal.ts";
import type { PersonId } from "../shared/ids.ts";

export const personPrincipal = (facts: {
  /** The memberships active in the current semester, whatever the state of their team. */
  readonly memberships: readonly MembershipFact[];
  readonly now: DateTime.Utc;
  readonly personId: PersonId;
  /** The `until` of every admin place the person holds, valid or not. */
  readonly placeEnds: readonly DateTime.Utc[];
}): PersonPrincipal =>
  Option.match(
    Arr.last(
      Arr.sort(
        Arr.filter(facts.placeEnds, DateTime.isGreaterThan(facts.now)),
        DateTime.Order
      )
    ),
    {
      onNone: () =>
        Principal.cases.Person.make({
          memberships: facts.memberships,
          personId: facts.personId,
        }),
      onSome: (adminUntil) =>
        Principal.cases.Person.make({
          adminUntil,
          memberships: facts.memberships,
          personId: facts.personId,
        }),
    }
  );
