/**
 * The spike's only source of authority, and it is test-only.
 *
 * `extendMembership` is granted to administrators and leaders, never to a `System` principal (a job's command is
 * granted to its own `System(job)` and nobody else, `packages/domain/src/kernel/domain.ts`). A scheduled renewal has
 * no signed-in person, so the spike needs someone to act as. This module makes that someone: a synthetic
 * administrator for the person named by `actorId`, valid for a long time, with no memberships. It is the same value
 * the model tests send commands as (`spikes/alchemy-domain/test/model.postgres.test.ts`, `adminPrincipal`), and it
 * reaches `decide` the same way: as `RequestPrincipal`, next to the `CommandFacts` that the database resolves.
 *
 * What it is not: an authenticated principal. Nothing here reads an account, an admin place or a session, and the
 * workflow parameters carry only the actor's id. A production renewal needs a real answer to "who is this on behalf
 * of" (the person who scheduled it, read through `PrincipalDirectory`, or a granted job); that is open work.
 */
import { Principal } from "@vektorprogrammet/domain";
import type { PersonId } from "@vektorprogrammet/domain";
import { DateTime } from "effect";

const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

/** A synthetic administrator: the test-owned authority. */
export const syntheticAdministrator = (personId: PersonId) =>
  Principal.cases.Person.make({ adminUntil: FAR, memberships: [], personId });
