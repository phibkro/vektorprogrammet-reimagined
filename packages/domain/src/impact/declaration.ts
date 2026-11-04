/**
 * The impact domain as data (spec 0027): `listImpact`, a read of the released cells that only an administrator holds
 * (D9: no grant row, as the audit read), and `closeImpact`, the command that the job `impactClose` runs as its own
 * principal.
 */
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  grant,
  info,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";
import { DomainErrorSchema, Forbidden } from "../shared/errors.ts";
import { CloseOutcome, ImpactReport } from "./services.ts";

export const listImpact = Rpc.make("listImpact", {
  error: Forbidden,
  success: ImpactReport,
}).annotate(
  Info,
  info({
    method: "list",
    note: "The cells are released: a count below the minimum is suppressed, and a cell that no source answers is unavailable (spec 0027).",
    resource: "Impact",
    summary:
      "Read the evidence of operations: assistants placed, schools served and placements, by closed semester and department.",
  })
);

export const closeImpact = Rpc.make("closeImpact", {
  error: DomainErrorSchema,
  success: CloseOutcome,
}).annotate(
  Info,
  info({
    job: "impactClose",
    method: ":close",
    resource: "ImpactSnapshot",
    summary:
      "Close the cells of every ended semester that a source answers, once: a closed cell never changes.",
  })
);

export const ImpactRpc = RpcGroup.make(listImpact, closeImpact);

export const ImpactDomain = declareDomain({
  commands: ImpactRpc,
  grants: [grant([system("impactClose")], ["closeImpact"], "all")],
  name: "impact",
  reads: {},
  title: "Evidence of operations",
});
