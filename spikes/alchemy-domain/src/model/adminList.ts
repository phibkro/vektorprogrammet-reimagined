/**
 * The AdminList aggregate: the admin places and the state of every account, decided together (spec 0006b R2, issue 17).
 *
 * The rule that an Active administrator is always left spans every administrator, and an `@alchemy.run/domain` aggregate
 * is one writer for one instance. Two aggregates, one for the places and one for the accounts, would make
 * "deactivate C" and "revoke A's place" two commits that cannot see each other: the race of issue 17, now with a
 * window between two instances. So the invariant gets one aggregate that owns both of its variables, the places and
 * the state of the accounts, and every command that can lower the count is decided here, on the whole list, by one
 * writer. This is the "invariant-shaped aggregate" of the Alchemy docs, and it is the kernel's design (one admin-list
 * row that every such command locks) with the lock kept by the platform.
 *
 * The cost is the same as the kernel's and stays visible: every account-state change of every person is a command on
 * this one instance, so they queue (R2 item 4 chose that on purpose), and the state holds an entry per account.
 * Person data is not here: ids and states only.
 */
import * as Domain from "@alchemy.run/domain";
import type { DecideContext } from "@alchemy.run/domain/Aggregate";
import {
  Accounts,
  AdminGrantId,
  Machine,
  PersonId,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Predicate,
  Schema,
} from "effect";

import { semesterForDate, semesterWindow } from "./calendar.ts";
import { RequestPrincipal } from "./context.ts";
import { GrantGuard, requireGrant } from "./guard.ts";
import { AdminListKey } from "./ids.ts";
import type { AdminListKeyValue } from "./ids.ts";
import {
  Conflict,
  Forbidden,
  NotFound,
  ValidationFailed,
  invalid,
} from "./rejections.ts";

// ------------------------------------------------------------------------------------------------- state

/** The tags of the kernel's `AccountState` union. */
const AccountStateTag = Schema.Literals(["Invited", "Active", "Deactivated"]);

export const StoredPlaceSchema = Schema.Struct({
  grantedBy: Schema.NullOr(PersonId),
  id: AdminGrantId,
  personId: PersonId,
  until: Schema.DateTimeUtc,
});

export type StoredPlaceValue = typeof StoredPlaceSchema.Type;

export const StoredAccount = Schema.Struct({
  personId: PersonId,
  state: AccountStateTag,
});

export const AdminListStateSchema = Schema.Struct({
  accounts: Schema.Array(StoredAccount),
  places: Schema.Array(StoredPlaceSchema),
});

export type AdminListStateValue = typeof AdminListStateSchema.Type;

// ------------------------------------------------------------------------------------------------ events

export class AdminPlaceGranted extends Domain.Event("AdminPlaceGranted", {
  grantedBy: Schema.NullOr(PersonId),
  id: AdminGrantId,
  personId: PersonId,
  until: Schema.DateTimeUtc,
}) {}

export class AdminPlaceRevoked extends Domain.Event("AdminPlaceRevoked", {
  id: AdminGrantId,
}) {}

export class AccountInvited extends Domain.Event("AccountInvited", {
  personId: PersonId,
}) {}

export class AccountActivated extends Domain.Event("AccountActivated", {
  personId: PersonId,
}) {}

export class AccountDeactivated extends Domain.Event("AccountDeactivated", {
  personId: PersonId,
}) {}

export class AccountReactivated extends Domain.Event("AccountReactivated", {
  personId: PersonId,
}) {}

// ---------------------------------------------------------------------------------------------- commands

const refusals = [Forbidden, NotFound, ValidationFailed, Conflict] as const;

export class CreateAdminGrant extends Domain.Command("createAdminGrant", {
  events: [AdminPlaceGranted],
  input: {
    personId: PersonId,
    placeId: AdminGrantId,
    until: Schema.DateTimeUtc,
  },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

export class DeleteAdminGrant extends Domain.Command("deleteAdminGrant", {
  events: [AdminPlaceRevoked],
  input: { id: AdminGrantId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

export class DeactivateAccount extends Domain.Command("deactivateAccount", {
  events: [AccountDeactivated],
  input: { personId: PersonId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

export class ReactivateAccount extends Domain.Command("reactivateAccount", {
  events: [AccountReactivated],
  input: { personId: PersonId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

export class CreateAccount extends Domain.Command("createAccount", {
  events: [AccountInvited],
  input: { personId: PersonId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

export class ActivateAccount extends Domain.Command("activateAccount", {
  events: [AccountActivated],
  input: { personId: PersonId },
  middleware: [GrantGuard],
  rejects: refusals,
  target: AdminListKey,
}) {}

// -------------------------------------------------------------------------------------------- the rule

const LAST_ADMIN =
  "Den siste administratorplassen som varer etter dette semesteret kan ikke fjernes.";

const UNTIL_PAST = "Administratorplassen må vare lenger enn nå.";

const accountOf = (state: AdminListStateValue, personId: PersonId) =>
  Arr.findFirst(state.accounts, (account) => account.personId === personId);

/**
 * The places that count as an Active administrator's (spec 0006b R2 item 1): a place that ends after a cut-off and that
 * an Active account holds. Both decisions of the rule read exactly this, so they cannot disagree about who counts.
 */
export const countingPlaces = (
  state: AdminListStateValue,
  validAfter: DateTime.Utc
): readonly StoredPlaceValue[] =>
  Arr.filter(
    state.places,
    (place) =>
      DateTime.isGreaterThan(place.until, validAfter) &&
      Option.exists(
        accountOf(state, place.personId),
        (account) => account.state === "Active"
      )
  );

/** The only person who holds a place that is valid at `now` and whose account is Active. */
export const isLastActiveAdmin = (
  state: AdminListStateValue,
  personId: PersonId,
  now: DateTime.Utc
): boolean => {
  const counting = countingPlaces(state, now);

  return (
    Arr.isReadonlyArrayNonEmpty(counting) &&
    Arr.every(counting, (place) => place.personId === personId)
  );
};

const actorOf = (principal: typeof RequestPrincipal.Service) =>
  Predicate.isTagged(principal, "Person") ? principal.personId : null;

const conflict = (personId: PersonId) =>
  new Conflict({
    entity: "Account",
    key: String(personId),
    message:
      "Kontoen er ikke i en tilstand som kommandoen kan starte fra. Last siden på nytt.",
  });

// ---------------------------------------------------------------------------------------------- decide

const createAdminGrant = Effect.fn("AdminList.createAdminGrant")(
  function* createAdminGrant(
    _state: AdminListStateValue,
    command: CreateAdminGrant,
    { now }: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("createAdminGrant");
    const granter = actorOf(yield* RequestPrincipal);

    if (granter === command.personId) {
      return yield* new Forbidden({ command: "createAdminGrant" });
    }

    if (!DateTime.isGreaterThan(command.until, now)) {
      return yield* invalid(["until"], UNTIL_PAST);
    }

    return [
      new AdminPlaceGranted({
        grantedBy: granter,
        id: command.placeId,
        personId: command.personId,
        until: command.until,
      }),
    ];
  }
);

const deleteAdminGrant = Effect.fn("AdminList.deleteAdminGrant")(
  function* deleteAdminGrant(
    state: AdminListStateValue,
    command: DeleteAdminGrant,
    { now }: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("deleteAdminGrant");
    const principal = yield* RequestPrincipal;

    const place = Arr.findFirst(
      state.places,
      (found) => found.id === command.id
    );

    if (Option.isNone(place)) {
      return yield* new NotFound({
        entity: "AdminGrant",
        key: String(command.id),
      });
    }

    if (actorOf(principal) === place.value.personId) {
      return yield* new Forbidden({ command: "deleteAdminGrant" });
    }

    const counting = countingPlaces(
      state,
      semesterWindow(semesterForDate(now)).end
    );

    if (
      Arr.some(counting, (found) => found.id === command.id) &&
      Arr.every(counting, (found) => found.id === command.id)
    ) {
      return yield* invalid(["id"], LAST_ADMIN);
    }

    return [new AdminPlaceRevoked({ id: command.id })];
  }
);

const deactivateAccount = Effect.fn("AdminList.deactivateAccount")(
  function* deactivateAccount(
    state: AdminListStateValue,
    command: DeactivateAccount,
    { now }: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("deactivateAccount");
    const principal = yield* RequestPrincipal;
    const account = accountOf(state, command.personId);

    if (Option.isNone(account)) {
      return yield* conflict(command.personId);
    }

    const [allowed] = Machine.available(
      Accounts.AccountMachine,
      "deactivateAccount",
      account.value.state,
      {
        actorId: actorOf(principal),
        lastActiveAdmin: isLastActiveAdmin(state, command.personId, now),
        personId: command.personId,
      }
    );

    return allowed === undefined
      ? yield* conflict(command.personId)
      : [new AccountDeactivated({ personId: command.personId })];
  }
);

const reactivateAccount = Effect.fn("AdminList.reactivateAccount")(
  function* reactivateAccount(
    state: AdminListStateValue,
    command: ReactivateAccount,
    _context: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("reactivateAccount");
    const principal = yield* RequestPrincipal;
    const account = accountOf(state, command.personId);

    if (Option.isNone(account)) {
      return yield* conflict(command.personId);
    }

    const [allowed] = Machine.available(
      Accounts.AccountMachine,
      "reactivateAccount",
      account.value.state,
      {
        actorId: actorOf(principal),
        lastActiveAdmin: false,
        personId: command.personId,
      }
    );

    return allowed === undefined
      ? yield* conflict(command.personId)
      : [new AccountReactivated({ personId: command.personId })];
  }
);

/** An invitation to an account that exists already changes nothing: the kernel's `invite` is `ON CONFLICT DO NOTHING`. */
const createAccount = Effect.fn("AdminList.createAccount")(
  function* createAccount(
    state: AdminListStateValue,
    command: CreateAccount,
    _context: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("createAccount");

    return Option.isSome(accountOf(state, command.personId))
      ? []
      : [new AccountInvited({ personId: command.personId })];
  }
);

const activateAccount = Effect.fn("AdminList.activateAccount")(
  function* activateAccount(
    state: AdminListStateValue,
    command: ActivateAccount,
    _context: DecideContext<AdminListKeyValue>
  ) {
    yield* requireGrant("activateAccount");
    const principal = yield* RequestPrincipal;
    const account = accountOf(state, command.personId);

    if (Option.isNone(account)) {
      return yield* conflict(command.personId);
    }

    const [allowed] = Machine.available(
      Accounts.AccountMachine,
      "activateAccount",
      account.value.state,
      {
        actorId: actorOf(principal),
        lastActiveAdmin: false,
        personId: command.personId,
      }
    );

    return allowed === undefined
      ? yield* conflict(command.personId)
      : [new AccountActivated({ personId: command.personId })];
  }
);

// -------------------------------------------------------------------------------------------- aggregate

const withAccountState = (
  state: AdminListStateValue,
  personId: PersonId,
  accountState: (typeof StoredAccount.Type)["state"]
): AdminListStateValue => ({
  ...state,
  accounts: Arr.some(state.accounts, (account) => account.personId === personId)
    ? Arr.map(state.accounts, (account) =>
        account.personId === personId
          ? { ...account, state: accountState }
          : account
      )
    : [...state.accounts, { personId, state: accountState }],
});

export class AdminList extends Domain.Aggregate("AdminList", {
  commands: [
    CreateAdminGrant,
    DeleteAdminGrant,
    CreateAccount,
    ActivateAccount,
    DeactivateAccount,
    ReactivateAccount,
  ],
  decide: {
    activateAccount,
    createAccount,
    createAdminGrant,
    deactivateAccount,
    deleteAdminGrant,
    reactivateAccount,
  },
  evolve: {
    AccountActivated: (state, event) =>
      withAccountState(state, event.personId, "Active"),
    AccountDeactivated: (state, event) =>
      withAccountState(state, event.personId, "Deactivated"),
    AccountInvited: (state, event) =>
      withAccountState(state, event.personId, "Invited"),
    AccountReactivated: (state, event) =>
      withAccountState(state, event.personId, "Active"),
    AdminPlaceGranted: (state, event) => ({
      ...state,
      places: [
        ...state.places,
        {
          grantedBy: event.grantedBy,
          id: event.id,
          personId: event.personId,
          until: event.until,
        },
      ],
    }),
    AdminPlaceRevoked: (state, event) => ({
      ...state,
      places: Arr.filter(state.places, (place) => place.id !== event.id),
    }),
  },
  id: AdminListKey,
  initial: { accounts: [], places: [] },
  state: AdminListStateSchema,
}) {}
