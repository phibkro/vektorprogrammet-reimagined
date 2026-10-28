/**
 * Public surface of `@vektorprogrammet/db` (see `README.md`). Consumers import
 * only from this root.
 *
 * The root is the adapter's composition surface (spec 0017, ADR 0014): the Layers that a composition root provides.
 * The domain declares the ports (`@vektorprogrammet/domain`), and the Drizzle schema stays inside this package.
 * `tools/db-path-spike`, an adapter-level harness, also uses `UniqueConstraint`, `transactional` and
 * `classifySqlFailure`.
 */

export { UniqueConstraint } from "./schema.ts";

export {
  DatabaseLive,
  ImportDatabaseLive,
  JobDatabaseLive,
  type DatabaseConfig,
} from "./databaseLive.ts";

export { transactional } from "./transactional.ts";

export { classifySqlFailure } from "./classifySqlFailure.ts";
