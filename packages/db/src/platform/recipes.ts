/**
 * How this adapter gives each capability of the domain (spec 0025): the PostgreSQL constructs that it uses, and only
 * those. A recipe is typed `PooledSafeConstruct`, so one that names an advisory lock, `LISTEN` or a session `SET` does not
 * type-check: the transaction constructs are independent of advisory locks by construction, not by a comment.
 *
 * An empty recipe is a capability that this adapter gives with no construct of its own: one statement (a snapshot), a role
 * (read-only reads), another system (the object store) or no adapter yet (analytics).
 */
import type { Capability } from "@vektorprogrammet/domain";

import type { PooledSafeConstruct } from "./constructs.ts";

export type Recipe = readonly PooledSafeConstruct[];

export const recipes = {
  AggregateLocks: ["row-lock"],
  AnalyticsReads: [],
  Claims: ["on-conflict-returning"],
  ConditionalWrites: ["conditional-update-returning"],
  Leases: ["on-conflict-returning", "conditional-update-returning"],
  NonOverlap: ["exclusion-constraint"],
  ObjectStore: [],
  ReadOnlyReads: [],
  Snapshots: [],
  Transactions: ["transaction-block", "begin-isolation-level", "savepoint"],
  UniqueKeys: ["unique-constraint"],
  WorkQueue: ["row-lock-skip-locked", "conditional-update-returning"],
} as const satisfies Readonly<Record<Capability, Recipe>>;
