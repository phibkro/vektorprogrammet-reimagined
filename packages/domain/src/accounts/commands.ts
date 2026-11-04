/**
 * Account commands run inside the caller's transaction; auth writes are outbox deliveries after commit.
 *
 * A command about one person takes that person's lock first (`AggregateLocks`, spec 0006b), reads what it decides on
 * through the token and writes through it. `deactivateAccount` and `reactivateAccount` can change who is an Active
 * administrator, which spans every administrator, so they lock the admin list before the person; `deactivateAccount`
 * decides through its token whether the person is the last Active administrator.
 */
import { DateTime, Effect, Option } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import * as Machine from "../kernel/machine.ts";
import type { Principal } from "../kernel/principal.ts";
import { AggregateLocks, lockAdminList } from "../shared/aggregate.ts";
import type { Locked } from "../shared/aggregate.ts";
import { Conflict } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import { Outbox } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import { personResource } from "../teams/personResource.ts";
import { PersonRepository } from "../teams/services.ts";
import {
  AccountDomain,
  AccountMachine,
  AccountRpc,
  activateAccount,
  createAccount,
  deactivateAccount,
  reactivateAccount,
  updatePerson,
} from "./declaration.ts";
import type { Account } from "./entities.ts";
import { InviteAccountMessage } from "./messages.ts";
import { personOf } from "./principal.ts";
import { AccountRepository } from "./services.ts";

const conflict = (personId: number) =>
  new Conflict({
    entity: "Account",
    key: String(personId),
    message: "Kontoen eller koden kan ikke brukes. Prøv igjen.",
  });

/** The person's lock, and the account read through it; a person without an account cannot be acted on. */
const lockAccount = Effect.fn("Account.lock")(function* lockAccount(
  personId: PersonId
) {
  const accounts = yield* AccountRepository;

  const locked = yield* (yield* AggregateLocks)
    .lock("Person", personId)
    .pipe(Effect.catchTag("NotFound", () => conflict(personId)));

  const found = yield* accounts.findLocked(locked);

  if (Option.isNone(found)) {
    return yield* conflict(personId);
  }

  return { account: found.value, locked };
});

/**
 * The machine decides on what the locks hold, and the repository applies the transition it chose: an account that
 * changed since is a `Conflict`.
 */
const changeState = Effect.fn("Account.changeState")(function* changeState(
  locked: Locked<"Person">,
  account: Account,
  principal: Principal,
  command: "activateAccount" | "deactivateAccount" | "reactivateAccount",
  lastActiveAdmin: boolean
) {
  const [transition] = Machine.available(
    AccountMachine,
    command,
    account.state._tag,
    {
      actorId: personOf(principal),
      lastActiveAdmin,
      personId: account.personId,
    }
  );

  if (transition === undefined) {
    return yield* conflict(account.personId);
  }

  return yield* (yield* AccountRepository).transition(locked, transition);
});

export const AccountHandlers = AccountRpc.toLayer({
  activateAccount: AccountDomain.handle(activateAccount, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId, email }, principal) =>
      Effect.gen(function* activation() {
        yield* InTransaction;
        const { account, locked } = yield* lockAccount(personId);
        const person = yield* (yield* PersonRepository).findLocked(locked);

        if (person.email !== email) {
          return yield* conflict(personId);
        }

        const activated = yield* changeState(
          locked,
          account,
          principal,
          "activateAccount",
          false
        );

        yield* (yield* AccountRepository).verifyEmail(locked);
        yield* recordAudit(principal, "account.activated", "Account", personId);

        return activated;
      }),
  }),
  createAccount: AccountDomain.handle(createAccount, {
    resource: ({ personId }) =>
      personResource(AccountDomain.authorize, "createAccount", personId),
    run: ({ personId }, principal) =>
      Effect.gen(function* invitation() {
        yield* InTransaction;
        const accounts = yield* AccountRepository;
        const outbox = yield* Outbox;
        // `personResource` took the lock before authorization: it is held, and this returns its token.
        const locked = yield* (yield* AggregateLocks).lock("Person", personId);
        const account = yield* accounts.invite(locked);
        yield* outbox.enqueue([InviteAccountMessage.make({ personId })]);
        yield* recordAudit(principal, "account.invited", "Account", personId);

        return account;
      }),
  }),
  deactivateAccount: AccountDomain.handle(deactivateAccount, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* deactivation() {
        yield* InTransaction;
        const accounts = yield* AccountRepository;
        const now = yield* DateTime.now;

        // Whether an Active administrator is left spans every administrator, so the list is locked first, and the
        // decision reads through its token.
        const adminList = yield* lockAdminList;
        const { account, locked } = yield* lockAccount(personId);

        const updated = yield* changeState(
          locked,
          account,
          principal,
          "deactivateAccount",
          yield* accounts.isLastActiveAdmin(adminList, personId, now)
        );

        yield* recordAudit(
          principal,
          "account.deactivated",
          "Account",
          personId
        );

        return updated;
      }),
  }),
  reactivateAccount: AccountDomain.handle(reactivateAccount, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* reactivation() {
        yield* InTransaction;
        yield* lockAdminList;
        const { account, locked } = yield* lockAccount(personId);

        const updated = yield* changeState(
          locked,
          account,
          principal,
          "reactivateAccount",
          false
        );

        yield* recordAudit(
          principal,
          "account.reactivated",
          "Account",
          personId
        );

        return updated;
      }),
  }),
  updatePerson: AccountDomain.handle(updatePerson, {
    resource: ({ personId }) =>
      personResource(AccountDomain.authorize, "updatePerson", personId),
    run: ({ personId, ...profile }, principal) =>
      Effect.gen(function* updatePersonProfile() {
        yield* InTransaction;
        // `personResource` took the lock before authorization: it is held, and this returns its token.
        const locked = yield* (yield* AggregateLocks).lock("Person", personId);

        const updated = yield* (yield* AccountRepository).updateProfile(
          locked,
          profile
        );

        yield* recordAudit(
          principal,
          "person.profileUpdated",
          "Person",
          personId
        );

        return updated;
      }),
  }),
});

export const withAccounts = Commands.inProcess(AccountRpc, AccountHandlers);

export const AccountEndpoints = {
  activateAccount: Commands.endpoint(activateAccount, (payload) =>
    withAccounts((client) => client.activateAccount(payload))
  ),
  createAccount: Commands.endpoint(createAccount, (payload) =>
    withAccounts((client) => client.createAccount(payload))
  ),
  deactivateAccount: Commands.endpoint(deactivateAccount, (payload) =>
    withAccounts((client) => client.deactivateAccount(payload))
  ),
  reactivateAccount: Commands.endpoint(reactivateAccount, (payload) =>
    withAccounts((client) => client.reactivateAccount(payload))
  ),
  updatePerson: Commands.endpoint(updatePerson, (payload) =>
    withAccounts((client) => client.updatePerson(payload))
  ),
};
