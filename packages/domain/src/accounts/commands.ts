/** Account commands run inside the caller's transaction; auth writes are outbox deliveries after commit. */
import { Array as Arr, DateTime, Effect, Option, Predicate } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import * as Machine from "../kernel/machine.ts";
import { CurrentPrincipal } from "../kernel/principal.ts";
import type { Principal } from "../kernel/principal.ts";
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
import type { Account, AccountState } from "./entities.ts";
import { PasswordHasher } from "./passwordHasher.ts";
import { codePrincipal } from "./principal.ts";
import { AccountRepository } from "./services.ts";

const conflict = (personId: PersonId) =>
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
    // Authorization depends on the person's department and memberships: hold its aggregate lock before reading them.
    yield* (yield* AccountRepository).lockPerson(personId);
    const person = yield* people.findById(personId);
    const membershipsOfPerson = yield* memberships.listByPerson(personId);

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

const lockAccount = Effect.fn("Account.lock")(function* lockAccount(
  personId: PersonId
) {
  const accounts = yield* AccountRepository;

  if (!(yield* accounts.lockPerson(personId))) {
    return yield* conflict(personId);
  }

  const found = yield* accounts.findForUpdate(personId);

  if (Option.isNone(found)) {
    return yield* conflict(personId);
  }

  return found.value;
});

const consumeCode = Effect.fn("Account.consumeCode")(function* consumeCode(
  personId: PersonId,
  purpose: CodePurpose,
  token: CodeToken,
  now: DateTime.Utc
) {
  const codes = yield* CodeRepository;
  const hash = yield* Effect.orDie(hashCode(token));

  const consumed = yield* codes.consume({
    hash,
    now,
    purpose,
    subject: personId,
  });

  if (!consumed) {
    return yield* conflict(personId);
  }

  return yield* Effect.void;
});

const changeState = Effect.fn("Account.changeState")(function* changeState(
  account: Account,
  principal: Principal,
  command: "activate" | "deactivate" | "reactivate",
  to: AccountState["_tag"],
  now: DateTime.Utc
) {
  const accounts = yield* AccountRepository;

  const lastActiveAdmin =
    command === "deactivate"
      ? yield* accounts.isLastActiveAdmin(account.personId, now)
      : false;

  if (
    !Machine.can(AccountMachine, command, account.state._tag, {
      actorId: personOf(principal),
      lastActiveAdmin,
      personId: account.personId,
    })
  ) {
    return yield* conflict(account.personId);
  }

  return yield* accounts.transition({
    from: account.state._tag,
    now,
    personId: account.personId,
    prohibitLastActiveAdmin: command === "deactivate",
    to,
  });
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
        const account = yield* lockAccount(personId);

        const activated = yield* changeState(
          account,
          principal,
          "activate",
          "Active",
          now
        );

        yield* consumeCode(personId, "activation", code, now);
        yield* (yield* AccountRepository).verifyEmail(personId);
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

        if (!(yield* accounts.lockPerson(personId))) {
          return yield* conflict(personId);
        }

        const found = yield* accounts.find(personId);

        if (Option.isNone(found)) {
          return yield* conflict(personId);
        }

        const account = found.value;

        const updated = yield* changeState(
          account,
          principal,
          "deactivate",
          "Deactivated",
          yield* DateTime.now
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
        // personResource has locked the Person in this same transaction before authorization.
        const accounts = yield* AccountRepository;
        const outbox = yield* Outbox;
        const account = yield* accounts.invite(personId);
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
        const account = yield* lockAccount(personId);

        const updated = yield* changeState(
          account,
          principal,
          "reactivate",
          "Active",
          yield* DateTime.now
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
        const account = yield* accounts.findActiveByPrivateEmail(email);

        if (Option.isSome(account)) {
          const { personId } = account.value;

          if (yield* accounts.lockPerson(personId)) {
            // Recheck both the address and state after acquiring the aggregate lock.
            const current = yield* accounts.findActiveByPrivateEmail(email);

            if (Option.isSome(current) && current.value.personId === personId) {
              yield* (yield* Outbox).enqueue([
                OutboxMessage.cases.IssueCode.make({
                  personId,
                  purpose: "resetPassword",
                }),
              ]);
            }
          }
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
        const account = yield* lockAccount(personId);

        if (!Predicate.isTagged(account.state, "Active")) {
          return yield* conflict(personId);
        }

        yield* consumeCode(personId, "resetPassword", code, now);
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

        // personResource has locked the Person in this same transaction before authorization.
        const updated = yield* (yield* AccountRepository).updateProfile(
          personId,
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
