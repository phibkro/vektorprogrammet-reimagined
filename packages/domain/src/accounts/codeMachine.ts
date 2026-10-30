/**
 * The life of an issued code as a transition table (ADR 0007, spec 0024): `[*] → Unsent → Usable → Used`.
 *
 * A code is stored `Unsent` in the transaction that mints it, the mail is sent after that commit, and a second
 * transaction makes it `Usable` (it acknowledges the send). Only a `Usable` code authenticates: `CodeRepository` reads
 * and consumes through this table, so an `Unsent` code, which may sit in the mailbox already, is refused until the
 * acknowledgement commits. A single-use code ends `Used`; the one reusable purpose (`alumniConsent`, `singleUse: false`
 * in `codePolicy`) stays `Usable` until it expires, and no transition says otherwise.
 *
 * The table's commands are the steps of the delivery job and the two commands that spend a code. The steps have no
 * endpoint and no grant: nobody asks for them, the delivery of an `IssueCode` message performs them as the system, so
 * the machine is not listed in a domain's `machines` (a transition there must name a command of the domain, and the
 * kernel's export to effx would change with a grant row that no principal holds). The generated documents draw it from
 * here (`docs/system/accounts.md`).
 *
 * A replaced code is not a transition. A new code for the same purpose and person removes the row that was there, in
 * whatever state, and stores a new row `Unsent` (RULE-220); the machine describes one issued code from its creation.
 * `Used` is terminal: no transition leaves it, and an expired code is a code that no transition is asked about.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Machine from "../kernel/machine.ts";
import { PersonId } from "../shared/ids.ts";
import { CodePurpose, CodeState } from "./code.ts";
import { activateAccount, resetPassword } from "./declaration.ts";

/** Mint a code for a purpose and store it unusable: transaction 1 of the delivery. */
const issueCode = Rpc.make("issueCode", {
  payload: { personId: PersonId, purpose: CodePurpose },
  success: Schema.Void,
});

/** Make the code usable after its mail has gone out: transaction 2 of the delivery. */
const acknowledgeCode = Rpc.make("acknowledgeCode", {
  payload: { personId: PersonId, purpose: CodePurpose },
  success: Schema.Void,
});

/**
 * Spend the code of an applicant's e-mail address (spec 0009). The command runs in `personalData` (it merges two
 * people when the address is already verified, and this module cannot import that one), and `codePolicy` names it; this
 * is its step in the table, as `issueCode` and `acknowledgeCode` are the steps of the delivery.
 */
const verifyApplicantEmail = Rpc.make("verifyApplicantEmail", {
  payload: { personId: PersonId },
  success: Schema.Void,
});

/** The commands that move a code: the two steps of the delivery, and the commands that spend a single-use code. */
const CodeRpc = RpcGroup.make(
  issueCode,
  acknowledgeCode,
  activateAccount,
  resetPassword,
  verifyApplicantEmail
);

/** The commands whose transition a repository applies to a stored code. */
export type CodeStep =
  | "acknowledgeCode"
  | "activateAccount"
  | "resetPassword"
  | "verifyApplicantEmail";

type CodeTransition = Machine.Transition<
  CodeState["_tag"],
  CodeStep | "issueCode",
  void
>;

/** The transitions of a code that exists: each starts from one stored state, so `Aggregates.apply` applies it. */
const steps = {
  acknowledgeCode: {
    command: "acknowledgeCode",
    from: ["Unsent"],
    to: "Usable",
  },
  activateAccount: { command: "activateAccount", from: ["Usable"], to: "Used" },
  resetPassword: { command: "resetPassword", from: ["Usable"], to: "Used" },
  verifyApplicantEmail: {
    command: "verifyApplicantEmail",
    from: ["Usable"],
    to: "Used",
  },
} as const satisfies Record<CodeStep, CodeTransition>;

export const CodeMachine = Machine.make({
  commands: CodeRpc,
  context: Schema.Void,
  name: "Code",
  states: CodeState,
  terminal: ["Used"],
  transitions: [
    { command: "issueCode", from: [Machine.Boundary], to: "Unsent" },
    steps.acknowledgeCode,
    steps.activateAccount,
    steps.resetPassword,
    steps.verifyApplicantEmail,
  ],
});

/** The transition that `command` applies to a stored code, as the table declares it. */
export const codeTransition = (command: CodeStep) => steps[command];
