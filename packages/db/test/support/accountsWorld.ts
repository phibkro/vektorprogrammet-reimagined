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

/** Applies the Account machine's transition `command` from `state` to the locked person's account. */
export const moveAccount = Effect.fnUntraced(function* moveAccount(
  locked: Locked,
  command: "activate" | "deactivate" | "reactivate",
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
  locked: Locked
) {
  yield* AccountRepository.use((accounts) => accounts.invite(locked)).pipe(
    Effect.orDie
  );

  return yield* moveAccount(locked, "activate", "Invited");
});
