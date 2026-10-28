/**
 * Public surface of `@vektorprogrammet/db` (see `README.md`). Consumers import
 * only from this root.
 */

export * as schema from "./schema.ts";

export { UniqueConstraint } from "./schema.ts";

export {
  DatabaseLive,
  JobDatabaseLive,
  type DatabaseConfig,
} from "./databaseLive.ts";

export { transactional } from "./transactional.ts";

export {
  classifySqlFailure,
  violatedUniqueConstraint,
} from "./classifySqlFailure.ts";
