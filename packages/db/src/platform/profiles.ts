/**
 * The connection profiles of this adapter (spec 0025): the one place that says how a client is configured for a platform,
 * why, and which constructs the platform leaves alone.
 *
 * `databaseLive.ts` builds its `PgClient` from a profile and nothing else, so the settings are not written twice: the
 * Worker's `DatabaseLive` is the `hyperdrive` profile and the importer's `ImportDatabaseLive` is the `direct` one. The
 * reasons are data too, and the generated page and the README quote them.
 *
 * `hyperdrive.allows` is typed `PooledSafeConstruct`: a `DirectOnlyConstruct` cannot be added to it, and
 * `directOnly` is what the direct profile has over it.
 */
import { DirectOnlyConstructs, PooledSafeConstructs } from "./constructs.ts";
import type {
  Construct,
  DirectOnlyConstruct,
  PooledSafeConstruct,
} from "./constructs.ts";

export interface ClientSettings {
  /** Whether the client names the statements it sends (`@effect/sql-pg`'s `prepare`). */
  readonly prepare: boolean;
  /** Whether several fibers' statements share one connection (`@effect/sql-pg`'s `multiplex`). */
  readonly multiplex: boolean;
  /** The pool size of one client. */
  readonly maxConnections: number;
}

export interface ConnectionProfile<Allowed extends Construct> {
  readonly name: "hyperdrive" | "direct";
  /** What sits between the client and the database. */
  readonly pooling: "transaction" | "none";
  readonly client: ClientSettings;
  /** Why each setting is what it is: the page and the README quote these. */
  readonly why: Readonly<Record<keyof ClientSettings, string>>;
  readonly allows: readonly Allowed[];
}

export const hyperdrive = {
  allows: PooledSafeConstructs,
  client: { maxConnections: 2, multiplex: false, prepare: false },
  name: "hyperdrive",
  pooling: "transaction",
  why: {
    maxConnections:
      "A Worker invocation can have six connections waiting at once (Workers limits) and Hyperdrive pools the origin side, so a request asks for few: two, one to hold a transaction and one more for a second transaction of the same request (the platform probe's two-connection checks).",
    multiplex:
      "Pipelining several fibers' statements on one connection is not documented for Hyperdrive (unverified), and a transaction needs the connection to itself.",
    prepare:
      'Hyperdrive documents named prepared statements for `postgres.js` and `node-postgres`, and says that other drivers "may have worse performance or may not be supported". `@effect/sql-pg` is a native wire client, so it is another driver. With `prepare: false` it sends Parse, Bind, Describe, Execute and Sync in one write and names no statement, so nothing depends on how the platform keeps statement names. That this path works through Hyperdrive is measured (every check of spec 0000); that named statements from `@effect/sql-pg` would work is not.',
  },
} as const satisfies ConnectionProfile<PooledSafeConstruct>;

export const direct = {
  allows: [...PooledSafeConstructs, ...DirectOnlyConstructs],
  client: { maxConnections: 2, multiplex: false, prepare: true },
  name: "direct",
  pooling: "none",
  why: {
    maxConnections: "The importer is sequential: two connections are plenty.",
    multiplex: "One transaction at a time on a connection.",
    prepare:
      "A direct connection keeps statement names for the session, as PostgreSQL does, so the client names its statements.",
  },
} as const satisfies ConnectionProfile<Construct>;

/** What only a direct connection has over Hyperdrive: the third table of the generated page. */
export const directOnly: readonly DirectOnlyConstruct[] = DirectOnlyConstructs;

/** Clients that reach Hyperdrive and are not built from a profile (listed on the page, so the gap is visible). */
export const otherConsumers = [
  {
    name: "Better Auth's `pg` pool",
    where: "`apps/web/src/server/auth.ts` (`max: 2`, unnamed statements)",
  },
  {
    name: "EmDash's Hyperdrive adapter",
    where:
      "`apps/cms` (a Hyperdrive configuration of its own, as the role `emdash_app`)",
  },
] as const;
