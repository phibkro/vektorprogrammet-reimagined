/** The outbox messages that `iam` enqueues (ADR 0015 stage 3, spec 0022 R4). The catalog lists them (`outbox/messages.ts`). */
import { Schema } from "effect";

import { PersonId } from "../shared/ids.ts";
import { declareMessage } from "../shared/outbox.ts";
import { CodePurpose } from "./code.ts";
import { PasswordHash } from "./passwordHasher.ts";

/** Mint a code for `purpose` and mail it to the person: the delivery mints, so no plaintext code is ever stored. */
export const IssueCodeMessage = declareMessage("IssueCode", {
  personId: PersonId,
  purpose: CodePurpose,
});

/** Write the person's credential after the domain commit: the hash, or none, and whether to end their sessions. */
export const SetCredentialMessage = declareMessage("SetCredential", {
  passwordHash: Schema.NullOr(PasswordHash),
  personId: PersonId,
  revokeSessions: Schema.Boolean,
});
