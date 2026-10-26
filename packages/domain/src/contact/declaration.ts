/**
 * The contact domain as data (spec 0006): C10. Anyone may submit a contact form (RULE-156); spam protection is
 * `apps/web`'s, before the command runs.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  anyone,
  grant,
  info,
  make as declareDomain,
} from "../kernel/domain.ts";
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
  Info,
  info({
    replaces: ["RULE-156", "RULE-249"],
    summary: "Send a message to a department's contact address.",
  })
);

export const ContactRpc = RpcGroup.make(submitContact);

export const ContactDomain = declareDomain({
  commands: ContactRpc,
  grants: [grant([anyone], ["submitContact"], "all")],
  name: "contact",
  reads: {},
  title: "Contact",
});
