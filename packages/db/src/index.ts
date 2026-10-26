/**
 * Public surface of `@vektorprogrammet/db` (see `README.md`). Consumers import
 * only from this root.
 */

export * as schema from "./schema.ts";

export { UniqueConstraint } from "./schema.ts";

export { DatabaseLive, type DatabaseConfig } from "./databaseLive.ts";

export { transactional } from "./transactional.ts";

export {
  classifySqlFailure,
  violatedUniqueConstraint,
} from "./classifySqlFailure.ts";

export {
  ClaimedOutboxMessage,
  OutboxClaimToken,
  OutboxDelivery,
  type OutboxAck,
} from "./repositories/outbox.ts";

export {
  DEFAULT_LOCAL_PERSON,
  LOCAL_PEOPLE,
  type LocalPerson,
} from "./localPeople.ts";
