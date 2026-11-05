/**
 * The connection profiles of this adapter (spec 0025): the one place that says how a client is configured for a platform,
 * why, and which constructs the platform leaves alone.
 *
 * The Worker uses conservative Supabase settings; the importer uses a direct profile.
 * The Hyperdrive profile and construct data below are historical evidence, not the active deployment.
 */
import { DirectOnlyConstructs, PooledSafeConstructs } from "./constructs.ts";
import type {
  Construct,
  DirectOnlyConstruct,
  PooledSafeConstruct,
} from "./constructs.ts";

interface ClientSettings {
  /** Whether the client names the statements it sends (`@effect/sql-pg`'s `prepare`). */
  readonly prepare: boolean;
  /** Whether several fibers' statements share one connection (`@effect/sql-pg`'s `multiplex`). */
  readonly multiplex: boolean;
  /** The pool size of one client. */
  readonly maxConnections: number;
}

export interface ConnectionProfile<Allowed extends Construct> {
  readonly name: "hyperdrive" | "direct" | "supabase";
  /** What sits between the client and the database. */
  readonly pooling: "transaction" | "none" | "unknown";
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

/** Conservative client settings for a Supabase URL, which may address a pooler or a direct connection. */
export const supabase = {
  allows: PooledSafeConstructs,
  client: { maxConnections: 2, multiplex: false, prepare: false },
  name: "supabase",
  pooling: "unknown",
  why: {
    maxConnections: "Each Worker request keeps its pool small.",
    multiplex: "A transaction needs its connection to itself.",
    prepare:
      "Unnamed statements do not depend on session affinity at a transaction pooler.",
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

/** The current Worker has no other database client outside the declared profiles. */
export const otherConsumers = [] as const;
