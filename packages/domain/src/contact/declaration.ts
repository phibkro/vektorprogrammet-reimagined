/**
 * The contact domain as data (spec 0006): C10. Anyone may submit a contact form (RULE-156); spam protection is
 * `apps/web`'s, before the command runs.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Commands from "../kernel/commands.ts";
import * as Domain from "../kernel/domain.ts";
import * as Grant from "../kernel/grant.ts";
import * as Subject from "../kernel/subject.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { DepartmentId, OutboxMessageId } from "../shared/ids.ts";
import { SupportTicket } from "./supportTicket.ts";

export const submitContact = Rpc.make("submitContact", {
  error: DomainErrorSchema,
  payload: SupportTicket,
  success: Schema.Struct({
    departmentId: DepartmentId,
    messageIds: Schema.Array(OutboxMessageId),
    notice: Schema.String,
  }),
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-156", "RULE-249"],
    summary: "Send a message to a department's contact address.",
  })
);

export const ContactRpc = RpcGroup.make(submitContact);

export const ContactDomain = Domain.make({
  commands: ContactRpc,
  grants: [Grant.make([Subject.anyone], ["submitContact"], "all")],
  name: "contact",
  reads: {},
  title: "Contact",
});
