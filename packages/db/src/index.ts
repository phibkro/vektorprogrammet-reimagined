/**
 * Public surface of `@vektorprogrammet/db` (see `README.md`). Consumers import
 * only from this root.
 */
import * as schema from "./schema.ts";

export { schema };
export { UniqueConstraint } from "./schema.ts";
export { DatabaseLive, type DatabaseConfig } from "./DatabaseLive.ts";
export { transactional } from "./transactional.ts";
export { classifySqlFailure, violatedUniqueConstraint } from "./classifySqlFailure.ts";
export {
  ClaimedOutboxMessage,
  OutboxClaimToken,
  OutboxDelivery,
  type OutboxAck,
} from "./repositories/outbox.ts";
