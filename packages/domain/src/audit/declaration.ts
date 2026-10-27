/**
 * The audit domain as data (spec 0006, R1): Phase 1's `ReadAudit` capability was "admin"; it is this command, held
 * through the admin row alone.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { Info, info, make as declareDomain } from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { AuditEntry } from "./auditLog.ts";

export const readAudit = Rpc.make("readAudit", {
  error: DomainErrorSchema,
  payload: {
    limit: Schema.Int.check(Schema.isBetween({ maximum: 500, minimum: 1 })),
  },
  success: Schema.Array(AuditEntry),
}).annotate(
  Info,
  info({ summary: "Read the newest entries of the audit log." })
);

export const AuditRpc = RpcGroup.make(readAudit);

export const AuditDomain = declareDomain({
  commands: AuditRpc,
  grants: [],
  name: "audit",
  reads: {},
  title: "Audit log",
});
