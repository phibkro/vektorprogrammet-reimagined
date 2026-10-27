/**
 * The database of the deployed run: a throwaway Neon branch of `dev`, which the tests reach as `neondb_owner` over a
 * direct connection (`DATABASE_URL`, put in the command's environment by `scripts/with-neon-branch.sh owner` and
 * nowhere else), while the deployed Worker reaches the same branch only through Hyperdrive, as `vp_app`.
 *
 * The branch holds `dev`'s migrated, fake-data schema. The initializer adds what the Worker needs and `dev` lacks: the
 * spike's tables, `vp_app`'s privileges on them, and sequences that start at 900,000,000, so that no synthetic row
 * shares an id with a row of the shared `dev` data or with a fixture of the local runs. The owner runs the DDL here;
 * the Worker's role has DML only (`vp_app` is "DML only" in `secretspec.toml`).
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import { Config, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  StaffingModel,
  staffingProjections,
} from "../../../alchemy-domain/src/model/model.ts";
import { layer as postgresPlatform } from "../../../alchemy-domain/src/postgresPlatform.ts";
import { initializeDatabase } from "../support/world.ts";

/** The first id of every synthetic row of the cloud run. */
export const SYNTHETIC_ID_START = 900_000_000;

/** The tables whose ids a fixture takes: each one's identity sequence is moved into the synthetic range. */
const FIXTURE_TABLES = [
  "department",
  "field_of_study",
  "person",
  "team",
  "membership",
] as const;

/** The least-privilege role that Hyperdrive connects as. */
const WORKER_ROLE = "vp_app";

const grantToWorkerRole = Effect.gen(function* grantToWorkerRole() {
  const sql = yield* SqlClient;

  const tables = yield* sql<{
    readonly name: string;
  }>`select tablename as name from pg_tables
      where schemaname = 'public'
        and (starts_with(tablename, 'alchemy_') or tablename = 'spike_renewal_notice')`;

  const sequences = yield* sql<{
    readonly name: string;
  }>`select sequencename as name from pg_sequences
      where schemaname = 'public'
        and (starts_with(sequencename, 'alchemy_') or starts_with(sequencename, 'spike_'))`;

  yield* Effect.forEach(
    tables,
    (table) =>
      sql.unsafe(
        `grant select, insert, update, delete on table "${table.name}" to ${WORKER_ROLE}`
      ),
    { discard: true }
  );

  yield* Effect.forEach(
    sequences,
    (sequence) =>
      sql.unsafe(
        `grant usage, select on sequence "${sequence.name}" to ${WORKER_ROLE}`
      ),
    { discard: true }
  );
});

/** Moves each fixture table's identity sequence to the synthetic range (never backwards, so a rerun cannot collide). */
const startSyntheticRange = Effect.gen(function* startSyntheticRange() {
  const sql = yield* SqlClient;

  yield* Effect.forEach(
    FIXTURE_TABLES,
    (table) =>
      sql.unsafe(
        `select setval(pg_get_serial_sequence('${table}', 'id'),
                greatest(${SYNTHETIC_ID_START}, coalesce((select max(id) from "${table}"), 0) + 1), false)`
      ),
    { discard: true }
  );
});

/** The explicit initializer of the branch: tables, grants, ids. Idempotent. */
export const initializeBranch = Effect.gen(function* initializeBranch() {
  yield* initializeDatabase;
  yield* grantToWorkerRole;
  yield* startSyntheticRange;
});

const database = Layer.unwrap(
  Effect.map(Config.Redacted("DATABASE_URL"), (url) =>
    DatabaseLive({ maxConnections: 4, url })
  )
);

/** The branch, initialized, with the model's services on the PostgreSQL platform. */
export const cloudWorld = StaffingModel.layer(staffingProjections).pipe(
  Layer.provideMerge(postgresPlatform({ migrate: false })),
  Layer.provideMerge(
    Layer.effectDiscard(initializeBranch).pipe(Layer.provideMerge(database))
  )
);
