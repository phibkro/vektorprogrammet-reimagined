/** The outbox messages that `iam` enqueues (ADR 0015 stage 3, spec 0022 R4). The catalog lists them (`outbox/messages.ts`). */
import { Schema } from "effect";

import { PersonId } from "../shared/ids.ts";
import { declareMessage } from "../shared/outbox.ts";
import { CodePurpose } from "./code.ts";

/** Mint a code for `purpose` and mail it to the person: the delivery mints, so no plaintext code is ever stored. */
export const IssueCodeMessage = declareMessage("IssueCode", {
  personId: PersonId,
  purpose: CodePurpose,
});

/** Invite delivery runs after the domain transaction commits. */
export const InviteAccountMessage = declareMessage("InviteAccount", {
  personId: PersonId,
});

export const DELETE_AUTH_USER = "DeleteAuthUser";
export const RELINK_AUTH_USER = "RelinkAuthUser";

/** Provider operations are delivered only after the domain transaction commits. */
export const DeleteAuthUserMessage = declareMessage(DELETE_AUTH_USER, {
  userId: Schema.String,
});

export const RelinkAuthUserMessage = declareMessage(RELINK_AUTH_USER, {
  from: PersonId,
  into: PersonId,
  userId: Schema.String,
});
