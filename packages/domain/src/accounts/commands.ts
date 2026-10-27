/**
 * Account commands run inside the caller's transaction; auth writes are outbox deliveries after commit.
 *
 * A command about one person takes that person's lock first (`AggregateLocks`, spec 0006b), reads what it decides on
 * through the token and writes through it. `deactivate` and `reactivate` can change who is an Active administrator,
 * which spans every administrator, so they lock the admin list before the person; `deactivate` decides through its
 * token whether the person is the last Active administrator.
 */
import { Array as Arr, DateTime, Effect, Option, Predicate } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import * as Machine from "../kernel/machine.ts";
import { CurrentPrincipal } from "../kernel/principal.ts";
import type { Principal } from "../kernel/principal.ts";
import { AggregateLocks, lockAdminList } from "../shared/aggregate.ts";
import type { Locked } from "../shared/aggregate.ts";
import { Conflict, Forbidden } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import { Outbox, OutboxMessage } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import {
  MembershipRepository,
  PersonRepository,
  TeamRepository,
} from "../teams/services.ts";
import { hashCode } from "./code.ts";
import type { CodePurpose, CodeToken } from "./code.ts";
import { CodeRepository } from "./codeRepository.ts";
import {
  AccountDomain,
  AccountMachine,
  AccountRpc,
  activate,
  deactivate,
  invite,
  reactivate,
  requestPasswordReset,
  resetPassword,
  updateProfile,
} from "./declaration.ts";
import type { Account } from "./entities.ts";
import { PasswordHasher } from "./passwordHasher.ts";
import { codePrincipal } from "./principal.ts";
import { AccountRepository } from "./services.ts";

const conflict = (personId: number) =>
  new Conflict({
    entity: "Account",
    key: String(personId),
    message: "Kontoen eller koden kan ikke brukes. Prøv igjen.",
  });

/** A person belongs to the field-of-study department and the departments of their memberships. */
const personResource = Effect.fn("Account.personResource")(
  function* personResource(
    personId: PersonId,
    command: "invite" | "updateProfile"
  ) {
    const people = yield* PersonRepository;
    const memberships = yield* MembershipRepository;
    const teams = yield* TeamRepository;
    const principal = yield* CurrentPrincipal;
    // Authorization depends on the person's department and memberships: take the person's lock, then read them.
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
        AccountDomain.authorize(principal, command, resource)
      ),
      () => ({ departmentId: person.departmentId, personId })
    );
  }
);

/** A code principal was resolved from a usable code before the command is run. */
const codeResource = Effect.map(CurrentPrincipal, (principal) =>
  Predicate.isTagged(principal, "Person")
    ? { personId: principal.personId }
    : {}
);

const personOf = (principal: Principal): PersonId | null =>
  Predicate.isTagged(principal, "Person") ? principal.personId : null;

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

const consumeCode = Effect.fn("Account.consumeCode")(function* consumeCode(
  locked: Locked<"Person">,
  purpose: CodePurpose,
  token: CodeToken,
  now: DateTime.Utc
) {
  const codes = yield* CodeRepository;
  const hash = yield* Effect.orDie(hashCode(token));
  const consumed = yield* codes.consume(locked, { hash, now, purpose });

  if (!consumed) {
    return yield* conflict(locked.id);
  }

  return yield* Effect.void;
});

/**
 * The machine decides on what the locks hold, and the repository applies the transition it chose: an account that
 * changed since is a `Conflict`.
 */
const changeState = Effect.fn("Account.changeState")(function* changeState(
  locked: Locked<"Person">,
  account: Account,
  principal: Principal,
  command: "activate" | "deactivate" | "reactivate",
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

const queueCredential = Effect.fn("Account.queueCredential")(
  function* queueCredential(
    personId: PersonId,
    password: string,
    revokeSessions: boolean
  ) {
    const hasher = yield* PasswordHasher;
    const outbox = yield* Outbox;
    const passwordHash = yield* hasher.hash(password);
    yield* outbox.enqueue([
      OutboxMessage.cases.SetCredential.make({
        passwordHash,
        personId,
        revokeSessions,
      }),
    ]);
  }
);

export const AccountHandlers = AccountRpc.toLayer({
  activate: AccountDomain.handle(activate, {
    resource: () => codeResource,
    run: ({ code, password }, principal) =>
      Effect.gen(function* activateAccount() {
        yield* InTransaction;
        const personId = personOf(principal);

        if (personId === null) {
          return yield* Effect.die("activation needs a code principal");
        }

        const now = yield* DateTime.now;
        const { account, locked } = yield* lockAccount(personId);

        const activated = yield* changeState(
          locked,
          account,
          principal,
          "activate",
          false
        );

        yield* consumeCode(locked, "activation", code, now);
        yield* (yield* AccountRepository).verifyEmail(locked);
        yield* queueCredential(personId, password, false);
        yield* recordAudit(principal, "account.activated", "Account", personId);

        return activated;
      }),
  }),
  deactivate: AccountDomain.handle(deactivate, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* deactivateAccount() {
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
          "deactivate",
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
  invite: AccountDomain.handle(invite, {
    resource: ({ personId }) => personResource(personId, "invite"),
    run: ({ personId }, principal) =>
      Effect.gen(function* inviteAccount() {
        yield* InTransaction;
        const accounts = yield* AccountRepository;
        const outbox = yield* Outbox;
        // `personResource` took the lock before authorization: it is held, and this returns its token.
        const locked = yield* (yield* AggregateLocks).lock("Person", personId);
        const account = yield* accounts.invite(locked);
        yield* outbox.enqueue([
          OutboxMessage.cases.IssueCode.make({
            personId,
            purpose: "activation",
          }),
        ]);
        yield* recordAudit(principal, "account.invited", "Account", personId);

        return account;
      }),
  }),
  reactivate: AccountDomain.handle(reactivate, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* reactivateAccount() {
        yield* InTransaction;
        yield* lockAdminList;
        const { account, locked } = yield* lockAccount(personId);

        const updated = yield* changeState(
          locked,
          account,
          principal,
          "reactivate",
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
  requestPasswordReset: AccountDomain.handle(requestPasswordReset, {
    resource: () => Effect.succeed({}),
    run: ({ email }) =>
      Effect.gen(function* requestReset() {
        yield* InTransaction;
        const accounts = yield* AccountRepository;
        const people = yield* PersonRepository;
        const candidate = yield* accounts.findActiveByPrivateEmail(email);

        if (Option.isNone(candidate)) {
          return;
        }

        const { personId } = candidate.value;

        const locked = yield* (yield* AggregateLocks)
          .lock("Person", personId)
          .pipe(Effect.option);

        if (Option.isNone(locked)) {
          return;
        }

        // Recheck both the address and the state through the lock: they may have changed since the candidate was found.
        const person = yield* people.findLocked(locked.value);
        const current = yield* accounts.findLocked(locked.value);

        if (
          person.email === email &&
          Option.exists(current, (account) =>
            Predicate.isTagged(account.state, "Active")
          )
        ) {
          yield* (yield* Outbox).enqueue([
            OutboxMessage.cases.IssueCode.make({
              personId,
              purpose: "resetPassword",
            }),
          ]);
        }
      }),
  }),
  resetPassword: AccountDomain.handle(resetPassword, {
    resource: () => codeResource,
    run: ({ code, password }, principal) =>
      Effect.gen(function* resetAccountPassword() {
        yield* InTransaction;
        const personId = personOf(principal);

        if (personId === null) {
          return yield* Effect.die("password reset needs a code principal");
        }

        const now = yield* DateTime.now;
        const { account, locked } = yield* lockAccount(personId);

        if (!Predicate.isTagged(account.state, "Active")) {
          return yield* conflict(personId);
        }

        yield* consumeCode(locked, "resetPassword", code, now);
        yield* queueCredential(personId, password, true);
        yield* recordAudit(
          principal,
          "account.passwordReset",
          "Account",
          personId
        );

        return yield* Effect.void;
      }),
  }),
  updateProfile: AccountDomain.handle(updateProfile, {
    resource: ({ personId }) => personResource(personId, "updateProfile"),
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

const runWithCode = Effect.fnUntraced(function* runWithCode<A, E, R>(
  purpose: CodePurpose,
  token: CodeToken,
  command: string,
  program: Effect.Effect<A, E, R | CurrentPrincipal>
) {
  const principal = yield* codePrincipal(token, purpose);

  if (Option.isNone(principal)) {
    return yield* new Forbidden({ command });
  }

  return yield* Effect.provideService(
    program,
    CurrentPrincipal,
    principal.value
  );
});

export const AccountEndpoints = {
  activate: Commands.endpoint(activate, (payload) =>
    runWithCode(
      "activation",
      payload.code,
      "activate",
      withAccounts((client) => client.activate(payload))
    )
  ),
  deactivate: Commands.endpoint(deactivate, (payload) =>
    withAccounts((client) => client.deactivate(payload))
  ),
  invite: Commands.endpoint(invite, (payload) =>
    withAccounts((client) => client.invite(payload))
  ),
  reactivate: Commands.endpoint(reactivate, (payload) =>
    withAccounts((client) => client.reactivate(payload))
  ),
  requestPasswordReset: Commands.endpoint(requestPasswordReset, (payload) =>
    withAccounts((client) => client.requestPasswordReset(payload))
  ),
  resetPassword: Commands.endpoint(resetPassword, (payload) =>
    runWithCode(
      "resetPassword",
      payload.code,
      "resetPassword",
      withAccounts((client) => client.resetPassword(payload))
    )
  ),
  updateProfile: Commands.endpoint(updateProfile, (payload) =>
    withAccounts((client) => client.updateProfile(payload))
  ),
};
