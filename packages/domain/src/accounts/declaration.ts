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

export const invite = Rpc.make("invite", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    replaces: ["RULE-207", "RULE-323"],
    summary: "Invite a person to activate an account.",
  })
);

export const activate = Rpc.make("activate", {
  error: DomainErrorSchema,
  payload: { code: CodeToken, password: Password },
  success: Account,
}).annotate(
  Info,
  info({
    credential: "activation",
    machine: "Account",
    replaces: ["RULE-131", "RULE-201"],
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
    replaces: ["RULE-112"],
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
    replaces: ["RULE-126", "RULE-166"],
    summary: "Reset an active account's password with its single-use code.",
  })
);

export const deactivate = Rpc.make("deactivate", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    note: "Never one's own account and never the last active admin.",
    replaces: ["RULE-202", "RULE-299"],
    summary: "Deactivate an account without changing the person.",
  })
);

export const reactivate = Rpc.make("reactivate", {
  error: DomainErrorSchema,
  payload: { personId: PersonId },
  success: Account,
}).annotate(
  Info,
  info({
    machine: "Account",
    note: "Never one's own account.",
    replaces: ["RULE-202", "RULE-299"],
    summary: "Reactivate a deactivated account.",
  })
);

export const updateProfile = Rpc.make("updateProfile", {
  error: DomainErrorSchema,
  payload: { personId: PersonId, ...PersonInput.fields },
  success: Person,
}).annotate(
  Info,
  info({
    replaces: ["RULE-143"],
    summary: "Update a person's profile.",
  })
);

export const AccountRpc = RpcGroup.make(
  invite,
  activate,
  requestPasswordReset,
  resetPassword,
  deactivate,
  reactivate,
  updateProfile
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
  transitions: [
    { command: "invite", from: [Machine.Boundary], to: "Invited" },
    { command: "activate", from: ["Invited"], to: "Active" },
    {
      command: "deactivate",
      from: ["Active"],
      guard: Schema.makeFilterGroup([differentPerson, notLastAdmin]),
      to: "Deactivated",
    },
    {
      command: "reactivate",
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
    grant([leader], ["invite", "updateProfile"], "department"),
    grant([self], ["updateProfile"], "own"),
    grant([holder("activation")], ["activate"], "own"),
    grant([holder("resetPassword")], ["resetPassword"], "own"),
    grant([anyone], ["requestPasswordReset"], "all"),
  ],
  machines: [AccountMachine],
  name: "accounts",
  reads: {},
  title: "Accounts and sessions",
});
