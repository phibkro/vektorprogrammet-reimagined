/**
 * Account fixtures (spec 0007) written the way a command writes them: under the person's lock, and a state change only
 * by applying a transition of the Account machine. The guards' facts are the neutral ones (no actor, not the last
 * admin), because a fixture sets a state up and does not test a guard.
 */
import {
  AccountRepository,
  Accounts,
  Machine,
  PersonId,
} from "@vektorprogrammet/domain";
import type { Locked } from "@vektorprogrammet/domain";
import { Array as Arr, Effect } from "effect";
import type { DateTime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { asPerson, grantPlace } from "./teamsWorld.ts";

/** Applies the Account machine's transition `command` from `state` to the locked person's account. */
export const moveAccount = Effect.fnUntraced(function* moveAccount(
  locked: Locked<"Person">,
  command: "activateAccount" | "deactivateAccount" | "reactivateAccount",
  state: "Active" | "Deactivated" | "Invited"
) {
  const moment: Accounts.AccountTransition = {
    actorId: null,
    lastActiveAdmin: false,
    personId: PersonId.make(locked.id),
  };

  const transition = yield* Effect.fromOption(
    Arr.head(Machine.available(Accounts.AccountMachine, command, state, moment))
  ).pipe(Effect.orDie);

  return yield* AccountRepository.use((accounts) =>
    accounts.transition(locked, transition)
  );
});

/** Invites the locked person and activates the account. It needs a transaction. */
export const activateAccount = Effect.fnUntraced(function* activateAccount(
  locked: Locked<"Person">
) {
  yield* AccountRepository.use((accounts) => accounts.invite(locked)).pipe(
    Effect.orDie
  );

  return yield* moveAccount(locked, "activateAccount", "Invited");
});

/**
 * An Active administrator: an Active account and a place on the admin list, each in a transaction of its own, as the
 * commands that make them would be. `until` ends the place.
 */
export const activeAdmin = Effect.fnUntraced(function* activeAdmin(
  personId: PersonId,
  until: DateTime.Utc
) {
  yield* asPerson(personId, activateAccount);

  return yield* grantPlace(personId, { grantedBy: null, until });
});

/**
 * Fresh state for a test of the admin list: no place and no account but the ones that the test makes. Every test of a
 * file shares one database, and an Active administrator that an earlier test left behind changes who is the last one.
 */
export const noAdmins = Effect.gen(function* noAdmins() {
  const sql = yield* SqlClient;
  yield* sql`delete from admin_grant`;
  yield* sql`delete from account`;
});
