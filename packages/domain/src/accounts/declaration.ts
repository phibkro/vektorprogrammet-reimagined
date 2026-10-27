/** Account commands, permissions and the stored Account machine (spec 0007). */
import { Schema, SchemaRepresentation } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  grant,
  holder,
  info,
  leader,
  self,
  anyone,
  make as declareDomain,
} from "../kernel/domain.ts";
import * as Machine from "../kernel/machine.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { PersonId } from "../shared/ids.ts";
import { Person, PersonEmailInput, PersonInput } from "../teams/entities.ts";
import { CodeToken } from "./code.ts";
import { Account, AccountState, Password } from "./entities.ts";

export const createAccount = Rpc.make("createAccount", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    method: "create",
    replaces: ["RULE-207", "RULE-323"],
    resource: "Account",
    summary: "Invite a person to activate an account.",
  })
);

export const activateAccount = Rpc.make("activateAccount", {
  error: DomainErrorSchema,
  payload: { code: CodeToken, password: Password },
  success: Account,
}).annotate(
  Info,
  info({
    credential: "activation",
    machine: "Account",
    method: ":activate",
    replaces: ["RULE-131", "RULE-201"],
    resource: "Account",
    summary: "Activate an invited account with its single-use code.",
  })
);

export const requestPasswordReset = Rpc.make("requestPasswordReset", {
  error: DomainErrorSchema,
  payload: { email: PersonEmailInput },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    method: ":requestPasswordReset",
    replaces: ["RULE-112"],
    resource: "Account",
    summary:
      "Request a password reset without revealing whether an account exists.",
  })
);

export const resetPassword = Rpc.make("resetPassword", {
  error: DomainErrorSchema,
  payload: { code: CodeToken, password: Password },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    credential: "resetPassword",
    method: ":resetPassword",
    replaces: ["RULE-126", "RULE-166"],
    resource: "Account",
    summary: "Reset an active account's password with its single-use code.",
  })
);

export const deactivateAccount = Rpc.make("deactivateAccount", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    method: ":deactivate",
    note: "Never one's own account and never the last active admin.",
    replaces: ["RULE-202", "RULE-299"],
    resource: "Account",
    summary: "Deactivate an account without changing the person.",
  })
);

export const reactivateAccount = Rpc.make("reactivateAccount", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    method: ":reactivate",
    note: "Never one's own account.",
    replaces: ["RULE-202", "RULE-299"],
    resource: "Account",
    summary: "Reactivate a deactivated account.",
  })
);

export const updatePerson = Rpc.make("updatePerson", {
  error: DomainErrorSchema,
  payload: { personId: PersonId, ...PersonInput.fields },
  success: Person,
}).annotate(
  Info,
  info({
    method: "update",
    replaces: ["RULE-143"],
    resource: "Person",
    summary: "Update a person's profile.",
  })
);

export const AccountRpc = RpcGroup.make(
  createAccount,
  activateAccount,
  requestPasswordReset,
  resetPassword,
  deactivateAccount,
  reactivateAccount,
  updatePerson
);

/** Facts checked before a state change; the command reads them through the locks of the people involved. */
export const AccountTransition = Schema.Struct({
  actorId: Schema.NullOr(PersonId),
  lastActiveAdmin: Schema.Boolean,
  personId: PersonId,
});

export type AccountTransition = typeof AccountTransition.Type;

const DIFFERENT_PERSON = "vektorprogrammet/account/different-person";
const NOT_LAST_ADMIN = "vektorprogrammet/account/not-last-active-admin";

const differentPerson = Schema.makeFilter<AccountTransition>(
  ({ actorId, personId }) => actorId !== personId,
  {
    expected: "an account other than the actor's",
    representation: {
      id: DIFFERENT_PERSON,
      payload: { left: ["actorId"], right: ["personId"] },
    },
  }
);

const notLastAdmin = Schema.makeFilter<AccountTransition>(
  ({ lastActiveAdmin }) => !lastActiveAdmin,
  {
    expected: "not the last active admin",
    representation: {
      id: NOT_LAST_ADMIN,
      payload: { operand: ["lastActiveAdmin"] },
    },
  }
);

/** Revive the represented guards, including the checks carried by branded person IDs. */
export const accountGuardRevivers = [
  SchemaRepresentation.isIntReviver,
  SchemaRepresentation.isGreaterThanReviver,
  SchemaRepresentation.makeReviverFilter(
    DIFFERENT_PERSON,
    Schema.Struct({
      left: Schema.Tuple([Schema.Literal("actorId")]),
      right: Schema.Tuple([Schema.Literal("personId")]),
    }),
    () => differentPerson
  ),
  SchemaRepresentation.makeReviverFilter(
    NOT_LAST_ADMIN,
    Schema.Struct({
      operand: Schema.Tuple([Schema.Literal("lastActiveAdmin")]),
    }),
    () => notLastAdmin
  ),
] as const;

export const AccountMachine = Machine.make({
  commands: AccountRpc,
  context: AccountTransition,
  name: "Account",
  states: AccountState,
  terminal: [],
  transitions: [
    { command: "createAccount", from: [Machine.Boundary], to: "Invited" },
    { command: "activateAccount", from: ["Invited"], to: "Active" },
    {
      command: "deactivateAccount",
      from: ["Active"],
      guard: Schema.makeFilterGroup([differentPerson, notLastAdmin]),
      to: "Deactivated",
    },
    {
      command: "reactivateAccount",
      from: ["Deactivated"],
      guard: differentPerson,
      to: "Active",
    },
  ],
});

/** One transition of the Account machine: what a repository applies to a stored account. */
export type AccountMachineTransition =
  (typeof AccountMachine)["transitions"][number];

export const AccountDomain = declareDomain({
  commands: AccountRpc,
  grants: [
    grant([leader], ["createAccount", "updatePerson"], "department"),
    grant([self], ["updatePerson"], "own"),
    grant([holder("activation")], ["activateAccount"], "own"),
    grant([holder("resetPassword")], ["resetPassword"], "own"),
    grant([anyone], ["requestPasswordReset"], "all"),
  ],
  machines: [AccountMachine],
  name: "accounts",
  reads: {},
  title: "Accounts and sessions",
});
