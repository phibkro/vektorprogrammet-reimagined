/** The audit read (C12): the newest entries, for an admin. */
import { Effect } from "effect";

import * as Commands from "../kernel/commands.ts";
import { AuditLog } from "./auditLog.ts";
import { AuditDomain, AuditRpc, readAudit } from "./declaration.ts";

export const AuditHandlers = AuditRpc.toLayer({
  readAudit: AuditDomain.handle(readAudit, {
    resource: () => Effect.succeed({}),
    run: ({ limit }) =>
      Effect.gen(function* run() {
        const log = yield* AuditLog;

        return yield* log.latest(limit);
      }),
  }),
});

/** The audit command behind the in-process client; see `Commands.inProcess`. */
export const withAudit = Commands.inProcess(AuditRpc, AuditHandlers);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const AuditEndpoints = {
  readAudit: Commands.endpoint(readAudit, (payload) =>
    withAudit((client) => client.readAudit(payload))
  ),
};
