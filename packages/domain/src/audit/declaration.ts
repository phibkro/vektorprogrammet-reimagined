/**
 * The audit domain as data (spec 0006, R1): Phase 1's `ReadAudit` capability was "admin"; it is this query, a `list` of
 * the audit log's entries, held through the admin row alone.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { Info, info, make as declareDomain } from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { AuditEntry } from "./auditLog.ts";

export const listAuditEntries = Rpc.make("listAuditEntries", {
  error: DomainErrorSchema,
  payload: {
    limit: Schema.Int.check(Schema.isBetween({ maximum: 500, minimum: 1 })),
  },
  success: Schema.Array(AuditEntry),
}).annotate(
  Info,
  info({
    method: "list",
    resource: "AuditEntry",
    summary: "Read the newest entries of the audit log.",
  })
);

export const AuditRpc = RpcGroup.make(listAuditEntries);

export const AuditDomain = declareDomain({
  commands: AuditRpc,
  grants: [],
  name: "audit",
  reads: {},
  title: "Audit log",
});
