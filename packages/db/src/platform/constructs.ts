/**
 * The PostgreSQL constructs that this adapter uses or refuses, and what Hyperdrive does with each (spec 0025).
 *
 * Plain data: the generated page (`docs/system/database-platforms.md`), the recipes, the statement scan and the probe read
 * it, and nothing here imports a client. A fact about a platform is a cell: what the platform does (`outcome`) and how
 * that is known (`how`). `unverified` is a real value: it says that nobody measured it, and the page prints it.
 *
 * **Two closed sets.** `PooledSafeConstruct` is what a transaction pooler leaves alone; `DirectOnlyConstruct` is what only
 * a direct connection keeps, because it lives in the session and a pooler hands the next statement to whichever server
 * connection is free. The sets are types: a recipe takes `PooledSafeConstruct` only, so a construct of the second set
 * does not type-check there, and the page's third table is the second set.
 *
 * **`pgTxmodeRow`** names the row of the `pg-txmode` catalogue that says the same thing (`phibkro/pg-txmode`, main at
 * `16e11ef`, where specs 0001 to 0003 and 0005 are merged). The package is private and unpublished, so the reference is
 * a pointer for a reader: no cell here rests on it alone, and nothing imports it.
 */

/** What a transaction pooler leaves alone: every construct that this adapter's recipes may name. */
export const PooledSafeConstructs = [
  "transaction-block",
  "begin-isolation-level",
  "savepoint",
  "row-lock",
  "row-lock-nowait",
  "row-lock-skip-locked",
  "on-conflict-returning",
  "conditional-update-returning",
  "unique-constraint",
  "exclusion-constraint",
  "set-local",
  "unnamed-statements",
] as const;

/** What only a direct connection keeps: no recipe, no repository and no server file may use any of these. */
export const DirectOnlyConstructs = [
  "advisory-lock-session",
  "advisory-lock-transaction",
  "listen",
  "notify",
  "set-session",
  "sql-prepare",
  "with-hold-cursor",
  "temporary-table",
  "load",
] as const;

export type PooledSafeConstruct = (typeof PooledSafeConstructs)[number];

export type DirectOnlyConstruct = (typeof DirectOnlyConstructs)[number];

export type Construct = PooledSafeConstruct | DirectOnlyConstruct;

/** `works`: as on PostgreSQL. `scoped`: only for the transaction or the statement. `differs`: succeeds, but not the same. */
export type Outcome =
  | "works"
  | "scoped"
  | "differs"
  | "unsupported"
  | "unknown";

/**
 * How a cell is known. `postgres-docs` and `hyperdrive-docs`: a primary source says so (the construct's `sources`).
 * `spec-0000`: the deployed Worker of slice 0000 measured it through Hyperdrive (`docs/specs/0000-results.md`).
 * `preview-route`: `GET /api/isolation` measures it on every pull request's Preview (spec 0018 R10).
 * `platform-probe`: `GET /api/platform` measures it there (`check` names the check). `unverified`: nobody measured it.
 */
export type HowKnown =
  | "postgres-docs"
  | "hyperdrive-docs"
  | "spec-0000"
  | "preview-route"
  | "platform-probe"
  | "unverified";

export interface Cell {
  readonly outcome: Outcome;
  readonly how: HowKnown;
  /** What is meant, in a sentence; for a probe, the id of the check. */
  readonly note: string;
}

export interface ConstructFact {
  readonly summary: string;
  readonly direct: Cell;
  readonly hyperdrive: Cell;
  readonly sources: readonly string[];
  /** A row of the `pg-txmode` catalogue (another repository, private and unpublished) that says the same; a pointer, never the evidence. */
  readonly pgTxmodeRow?: string;
}

const hyperdrivePooling =
  "https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/";

const hyperdriveSupported =
  "https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/";

const pgLocking =
  "https://www.postgresql.org/docs/current/explicit-locking.html";

const pgSelect =
  "https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE";

const works = (how: HowKnown, note: string): Cell => ({
  how,
  note,
  outcome: "works",
});

export const constructFacts = {
  "advisory-lock-session": {
    direct: works("postgres-docs", "Held by the session until released."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "Listed as unsupported. Behind a pooler the lock stays on a server connection that the next client of the pool gets, so a second client finds a lock it believes it holds (reproduced on PgBouncer in the research report, M1).",
      outcome: "unsupported",
    },
    pgTxmodeRow: "advisory-session",
    sources: [
      hyperdriveSupported,
      `${pgLocking}#ADVISORY-LOCKS`,
      "https://www.pgbouncer.org/features.html",
    ],
    summary:
      "`pg_advisory_lock`, `pg_try_advisory_lock` and the `_shared` forms: a lock that the session holds.",
  },
  "advisory-lock-transaction": {
    direct: works("postgres-docs", "Held until the transaction ends."),
    hyperdrive: {
      how: "unverified",
      note: 'Not settled by the documents: Cloudflare lists "Advisory locks" as unsupported without separating the session level from the transaction level. This adapter does not use the transaction-level form, so that nothing depends on the answer.',
      outcome: "unknown",
    },
    pgTxmodeRow: "advisory-xact",
    sources: [hyperdriveSupported, `${pgLocking}#ADVISORY-LOCKS`],
    summary:
      "`pg_advisory_xact_lock` and `pg_try_advisory_xact_lock`: a lock that the transaction holds.",
  },
  "begin-isolation-level": {
    direct: works(
      "postgres-docs",
      "The level of the transaction, set by its own BEGIN."
    ),
    hyperdrive: works(
      "preview-route",
      "The clause arrives: a transaction begun at SERIALIZABLE reads `serializable` on every Preview (`GET /api/isolation`, spec 0018 R10)."
    ),
    pgTxmodeRow: "isolation-level",
    sources: [
      "https://www.postgresql.org/docs/current/transaction-iso.html",
      hyperdrivePooling,
    ],
    summary:
      "`BEGIN ISOLATION LEVEL …`: the isolation floor stated by the transaction itself (TX3).",
  },
  "conditional-update-returning": {
    direct: works(
      "postgres-docs",
      "Judged at the newest committed state of the row."
    ),
    hyperdrive: {
      how: "unverified",
      note: "One statement and its row count; nothing in the platform's documents changes it. No check of this repository isolates it on Hyperdrive.",
      outcome: "works",
    },
    sources: ["https://www.postgresql.org/docs/current/sql-update.html"],
    summary:
      "`UPDATE … WHERE <expected state> RETURNING …`: a write that depends on the state it read (CW1).",
  },
  "exclusion-constraint": {
    direct: works("postgres-docs", "Refused with SQLSTATE 23P01."),
    hyperdrive: {
      how: "unverified",
      note: "The constraint is the engine's. That SQLSTATE 23P01 reaches the client through Hyperdrive is not in spec 0000's results (23505 is).",
      outcome: "works",
    },
    pgTxmodeRow: "sqlstate-passthrough",
    sources: [
      "https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-EXCLUSION",
      "https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/",
    ],
    summary:
      "`EXCLUDE USING gist`: memberships of one person in one team never overlap (NO1).",
  },
  listen: {
    direct: works("postgres-docs", "The session receives notifications."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "Listed as unsupported. The channel belongs to a session, and a pooler gives the session to someone else.",
      outcome: "unsupported",
    },
    pgTxmodeRow: "listen",
    sources: [
      hyperdriveSupported,
      "https://www.postgresql.org/docs/current/sql-listen.html",
    ],
    summary: "`LISTEN` and `UNLISTEN`.",
  },
  load: {
    direct: works("postgres-docs", "Loads a shared library into the session."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "A change to per-session state that the documents do not list as supported.",
      outcome: "unsupported",
    },
    pgTxmodeRow: "other-session-state",
    sources: [
      hyperdriveSupported,
      "https://www.postgresql.org/docs/current/sql-load.html",
    ],
    summary: "`LOAD`.",
  },
  notify: {
    direct: works("postgres-docs", "Delivered to the listeners."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "Listed as unsupported.",
      outcome: "unsupported",
    },
    pgTxmodeRow: "notify",
    sources: [
      hyperdriveSupported,
      "https://www.postgresql.org/docs/current/sql-notify.html",
    ],
    summary: "`NOTIFY` and `pg_notify`.",
  },
  "on-conflict-returning": {
    direct: works(
      "postgres-docs",
      "One caller inserts; the others see the conflict."
    ),
    hyperdrive: works(
      "spec-0000",
      "`INSERT … ON CONFLICT … RETURNING` and 20 concurrent upserts of one key passed through Hyperdrive (checks 5 and 8, 2026-10-16)."
    ),
    pgTxmodeRow: "on-conflict",
    sources: [
      "https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT",
    ],
    summary:
      "`INSERT … ON CONFLICT … RETURNING`: a claim with one winner, find-or-create (CL2, UK3).",
  },
  "row-lock": {
    direct: works(
      "postgres-docs",
      "Held until the transaction ends; a second request waits."
    ),
    hyperdrive: works(
      "platform-probe",
      "`lock-excludes-second-holder` and `lock-ends-with-its-transaction`: two transactions on two pooled connections (`GET /api/platform`)."
    ),
    pgTxmodeRow: "row-locks",
    sources: [pgSelect, pgLocking],
    summary:
      "`SELECT … FOR NO KEY UPDATE`: the aggregate lock; one writer per root until the transaction ends (LK1).",
  },
  "row-lock-nowait": {
    direct: works(
      "postgres-docs",
      "Answers SQLSTATE 55P03 instead of waiting."
    ),
    hyperdrive: works(
      "platform-probe",
      "The probe's way to ask whether a lock is held: used in `lock-excludes-second-holder`."
    ),
    sources: [pgSelect],
    summary:
      "`… FOR NO KEY UPDATE NOWAIT`: an error answer instead of a wait (the probe only).",
  },
  "row-lock-skip-locked": {
    direct: works(
      "postgres-docs",
      "A row that another transaction holds is left out."
    ),
    hyperdrive: works(
      "platform-probe",
      "`held-record-is-not-handed-on` (`GET /api/platform`)."
    ),
    pgTxmodeRow: "skip-locked",
    sources: [pgSelect],
    summary:
      "`FOR UPDATE SKIP LOCKED`: the outbox claim never takes a row that another claimer holds (LS1).",
  },
  savepoint: {
    direct: works(
      "postgres-docs",
      "A nested scope that fails rolls back to its savepoint."
    ),
    hyperdrive: works(
      "spec-0000",
      "A nested savepoint, inner failure and outer commit, passed through Hyperdrive (check 4, 2026-10-16); `nested-scope-undoes-alone` repeats it on every Preview."
    ),
    pgTxmodeRow: "savepoints",
    sources: ["https://www.postgresql.org/docs/current/sql-savepoint.html"],
    summary:
      "`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`: a nested `Transactor.run` (TX2).",
  },
  "set-local": {
    direct: works("postgres-docs", "Lasts to the end of the transaction."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: 'Supported "for the duration of a transaction or a query"; the connection is RESET when it is returned to the pool.',
      outcome: "scoped",
    },
    pgTxmodeRow: "set-local",
    sources: [
      hyperdrivePooling,
      "https://www.postgresql.org/docs/current/sql-set.html",
    ],
    summary:
      "`SET LOCAL` and `set_config(…, true)`: a setting for one transaction.",
  },
  "set-session": {
    direct: works("postgres-docs", "Lasts for the session."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "The connection is RESET when it is returned to the pool, so the setting vanishes with no error, and on a pooler that does not reset it leaks to the next client (reproduced on PgBouncer, research report M1).",
      outcome: "scoped",
    },
    pgTxmodeRow: "set-session",
    sources: [
      hyperdrivePooling,
      "https://www.postgresql.org/docs/current/sql-set.html",
    ],
    summary:
      "`SET`, `RESET`, `SET SESSION` and `set_config(…, false)`: a setting for the session.",
  },
  "sql-prepare": {
    direct: works("postgres-docs", "A statement kept by name in the session."),
    hyperdrive: {
      how: "hyperdrive-docs",
      note: "Listed as unsupported: `PREPARE`, `EXECUTE`, `DEALLOCATE` and `DISCARD` at the SQL level. (Protocol-level named statements are another matter, and `prepare: false` is about those: see the README.)",
      outcome: "unsupported",
    },
    pgTxmodeRow: "sql-prepare",
    sources: [
      hyperdriveSupported,
      "https://www.postgresql.org/docs/current/sql-prepare.html",
    ],
    summary: "`PREPARE`, `EXECUTE`, `DEALLOCATE`, `DISCARD`.",
  },
  "temporary-table": {
    direct: works(
      "postgres-docs",
      "Lives in the session (`ON COMMIT` says when its rows go)."
    ),
    hyperdrive: {
      how: "unverified",
      note: "Not documented either way. A table that keeps its rows past the transaction belongs to a session that a pooler hands on; this adapter uses none.",
      outcome: "unknown",
    },
    pgTxmodeRow: "temp-table-preserve",
    sources: ["https://www.postgresql.org/docs/current/sql-createtable.html"],
    summary: "`CREATE TEMP TABLE`.",
  },
  "transaction-block": {
    direct: works("postgres-docs", "BEGIN to COMMIT or ROLLBACK."),
    hyperdrive: works(
      "spec-0000",
      "Commit, rollback on a typed failure and rollback on interruption passed through Hyperdrive (checks 2, 3a, 3b, 2026-10-16); `rollback-leaves-nothing` repeats the rollback on every Preview."
    ),
    sources: [hyperdrivePooling],
    summary:
      "`BEGIN … COMMIT` and `ROLLBACK`: the atomic unit of every command (TX1).",
  },
  "unique-constraint": {
    direct: works("postgres-docs", "Refused with SQLSTATE 23505."),
    hyperdrive: works(
      "spec-0000",
      "A unique violation reached `classifySqlFailure` through Hyperdrive (check 6, 2026-10-16)."
    ),
    pgTxmodeRow: "sqlstate-passthrough",
    sources: [
      "https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS",
      "https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/",
    ],
    summary: "`UNIQUE` and unique indexes: a natural key has one record (UK1).",
  },
  "unnamed-statements": {
    direct: works(
      "postgres-docs",
      "The extended protocol without a statement name."
    ),
    hyperdrive: works(
      "platform-probe",
      "Every statement of every check of slice 0000 ran unnamed (`prepare: false`); `statements-follow-the-profile` shows that the client sends none by name on every Preview."
    ),
    pgTxmodeRow: "unnamed-statements",
    sources: [
      "https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY",
      "https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/",
    ],
    summary:
      "Statements sent without a name (`prepare: false`): Parse, Bind, Describe, Execute and Sync in one write.",
  },
  "with-hold-cursor": {
    direct: works("postgres-docs", "The cursor outlives the transaction."),
    hyperdrive: {
      how: "unverified",
      note: "Not documented either way; a cursor that outlives its transaction belongs to a session that a pooler hands on.",
      outcome: "unknown",
    },
    pgTxmodeRow: "with-hold-cursor",
    sources: ["https://www.postgresql.org/docs/current/sql-declare.html"],
    summary: "`DECLARE … WITH HOLD`.",
  },
} as const satisfies Readonly<Record<Construct, ConstructFact>>;
