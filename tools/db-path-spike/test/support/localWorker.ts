/**
 * A local rehearsal of the deployed spike: the Worker's real `fetch`, in process, over a
 * disposable database on devenv's PostgreSQL 18 (`TEST_DATABASE_ADMIN_URL`) where the
 * spike migrations ran as the owner. The Worker connects as `vp_app`, so the grants the
 * migration gives (DML only) are the ones exercised. A missing admin URL fails the
 * suite; it never skips it.
 *
 * What this cannot prove is the platform: Hyperdrive, Neon and workerd. A local pass
 * shows the checks' own logic is sound, so a deployed failure is the platform's.
 */
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import {
  Config,
  Context,
  Effect,
  Layer,
  Random,
  Record as Rec,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Reactivity from "effect/reactivity/Reactivity";

import worker from "../../src/worker.ts";
import type { SpikeEnv } from "../../src/worker/database.ts";

const migrationsFolder = new URL("../../drizzle/", import.meta.url).pathname;

/** One request to the Worker. */
export interface CallOptions {
  readonly method: "GET" | "POST";
  readonly params?: Readonly<Record<string, string>>;
  readonly path: string;
  readonly signal?: AbortSignal;
}

export class LocalWorker extends Context.Service<
  LocalWorker,
  {
    readonly call: (options: CallOptions) => Effect.Effect<Response>;
    readonly env: SpikeEnv;
    /** Waits for the Worker's background work (`waitUntil`) to end. */
    readonly settle: Effect.Effect<void>;
  }
>()("test/LocalWorker") {}

/** The body of `response`, decoded with the contract schema. */
export const answerOf = <A>(schema: Schema.Codec<A>) =>
  Effect.fnUntraced(function* decodeAnswer(response: Response) {
    const body = yield* Effect.promise(async () => await response.text());

    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body);
  });

const adminUrl = Config.Redacted("TEST_DATABASE_ADMIN_URL");

const provision = (surgery: readonly string[]) =>
  Effect.gen(function* provisioned() {
    const admin = yield* adminUrl;
    const adminClient = yield* PgClient.make({ maxConnections: 1, url: admin });
    const suffix = (yield* Random.nextIntBetween(0, 2 ** 31)).toString(36);
    const database = `vp_spike_test_${suffix}`;

    yield* adminClient.unsafe(`create database "${database}"`);
    yield* Effect.addFinalizer(() =>
      adminClient
        .unsafe(`drop database if exists "${database}" with (force)`)
        .pipe(Effect.orDie)
    );

    // Suites run in parallel: two of them may create the role at once.
    yield* adminClient.unsafe(
      `do $$ begin create role vp_app login; exception when duplicate_object or unique_violation then null; end $$`
    );

    const ownerUrl = new URL(Redacted.value(admin));
    ownerUrl.pathname = `/${database}`;
    const appUrl = new URL(ownerUrl);
    appUrl.username = "vp_app";

    const owner = yield* PgClient.make({
      maxConnections: 1,
      prepare: false,
      url: Redacted.make(ownerUrl.toString()),
    });

    yield* Effect.gen(function* applyMigrations() {
      const db = yield* PgDrizzle.makeWithDefaults();
      yield* Effect.suspend(() =>
        migrate(db, {
          migrationsFolder,
          migrationsSchema: "public",
          migrationsTable: "spike_0000_migrations",
        })
      );
    }).pipe(Effect.provideService(PgClient.PgClient, owner));

    yield* Effect.forEach(surgery, (statement) => owner.unsafe(statement));

    const env: SpikeEnv = {
      HYPERDRIVE: { connectionString: appUrl.toString() },
    };

    const background: Promise<unknown>[] = [];

    const ctx = {
      waitUntil: (work: Promise<unknown>) => background.push(work),
    };

    return LocalWorker.of({
      call: ({ method, params, path, signal }) =>
        Effect.promise(async () => {
          const url = new URL(path, "https://spike.test");
          url.search = new URLSearchParams(params).toString();

          return await worker.fetch(
            new Request(
              url,
              signal === undefined ? { method } : { method, signal }
            ),
            env,
            ctx
          );
        }),
      env,
      settle: Effect.promise(async () => await Promise.allSettled(background)),
    });
  }).pipe(Effect.provide(Reactivity.layer), Effect.orDie);

/**
 * A disposable database and the Worker over it. `surgery` runs as the owner after the
 * migrations: a negative control changes the schema so a check must fail.
 */
export const localWorker = (options?: {
  readonly surgery?: readonly string[];
}) => Layer.effect(LocalWorker, provision(options?.surgery ?? []));

/**
 * An `HttpClient` answered by the in-process Worker. The smoke command's real client and
 * checks run over it, so only the TCP wire is missing from the rehearsal.
 */
export const localHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* localHttp() {
    const local = yield* LocalWorker;

    return HttpClient.make((request, url, signal) =>
      Effect.map(
        local.call({
          method: request.method === "GET" ? "GET" : "POST",
          params: Rec.fromEntries(url.searchParams),
          path: url.pathname,
          signal,
        }),
        (response) => HttpClientResponse.fromWeb(request, response)
      )
    );
  })
);
