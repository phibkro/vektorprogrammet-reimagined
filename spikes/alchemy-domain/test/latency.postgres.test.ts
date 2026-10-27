import { assert, it } from "@effect/vitest";
import { DatabaseLive, transactional } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import type { PersonId } from "@vektorprogrammet/domain";
import {
  CurrentPrincipal,
  MembershipId,
  Principal,
  SiteOrigin,
  TeamsEndpoints,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Clock,
  DateTime,
  Effect,
  Layer,
  Logger,
  Order,
  References,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { world as makeWorld } from "../../../packages/db/test/support/teamsWorld.ts";
import { CommandFacts, RequestPrincipal } from "../src/model/context.ts";
import { factsOf } from "../src/model/facts.ts";
import { PersonKey } from "../src/model/ids.ts";
import { StaffingModel, staffingProjections } from "../src/model/model.ts";
import { CreateMembership, Person } from "../src/model/person.ts";
import { layer as postgresPlatform } from "../src/postgresPlatform.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const CURRENT = { term: "HOST", year: 2026 } as const;
const NEXT_AUTUMN = { term: "HOST", year: 2027 } as const;
const ADMIN_UNTIL = DateTime.makeUnsafe("2099-12-31T23:59:59.999Z");
const TIMED_SAMPLES = 100;
const WARMUP_SAMPLES = 20;

const database = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    postgresPlatform({ now: Effect.succeed(DateTime.toEpochMillis(NOW)) }).pipe(
      Layer.provideMerge(DatabaseLive({ maxConnections: 30, url }))
    )
  )
).pipe(Layer.provideMerge(migratedTestDatabase));

const modelWorld = StaffingModel.layer(staffingProjections).pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(Layer.succeed(SiteOrigin)("https://benchmark.example"))
);

const adminFor = (personId: PersonId) =>
  Principal.cases.Person.make({
    adminUntil: ADMIN_UNTIL,
    memberships: [],
    personId,
  });

const nextMembershipId = Effect.gen(function* nextMembershipId() {
  const sql = yield* SqlClient;

  const rows = yield* sql.unsafe(
    "select nextval(pg_get_serial_sequence('membership', 'id'))::int as id"
  );

  const [row] = rows;

  if (row === undefined) {
    return yield* Effect.die("missing membership identity");
  }

  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.Finite })
  )(row).pipe(Effect.orDie);

  return MembershipId.make(decoded.id);
});

const measure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* measureOne() {
    const start = yield* Clock.monotonicTimeNanos;
    yield* effect;
    const end = yield* Clock.monotonicTimeNanos;

    return Number(end - start) / 1_000_000;
  });

const isRepositoryFirst = (sample: number) =>
  sample % 4 === 1 || sample % 4 === 0;

const measureInOrder = <RA, RE, RR, AA, AE, AR>(
  repositoryCommand: Effect.Effect<RA, RE, RR>,
  alchemyCommand: Effect.Effect<AA, AE, AR>,
  repositoryFirst: boolean
) =>
  Effect.gen(function* measurePair() {
    if (repositoryFirst) {
      const repositoryElapsed = yield* measure(repositoryCommand);
      const alchemyElapsed = yield* measure(alchemyCommand);

      return { alchemyElapsed, repositoryElapsed };
    }

    const alchemyElapsed = yield* measure(alchemyCommand);
    const repositoryElapsed = yield* measure(repositoryCommand);

    return { alchemyElapsed, repositoryElapsed };
  });

const percentile = (values: readonly number[], fraction: number) => {
  const sorted = Arr.sort(values, Order.Number);

  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1
  );

  return sorted[index] ?? 0;
};

const summary = (values: readonly number[]) =>
  `p50=${percentile(values, 0.5).toFixed(3)}ms p95=${percentile(
    values,
    0.95
  ).toFixed(3)}ms max=${percentile(values, 1).toFixed(3)}ms`;

it.live(
  "same-machine PostgreSQL membership-command latency: repository vs Alchemy Person with synchronous projection",
  () =>
    Effect.gen(function* latencyComparison() {
      const people = yield* Person;
      const repositoryTimes: number[] = [];
      const alchemyTimes: number[] = [];

      for (const sample of Arr.range(1, WARMUP_SAMPLES + TIMED_SAMPLES)) {
        const code = sample.toString(36).padStart(2, "0");
        const repoFixture = yield* makeWorld(`r${code}x`);
        const alchemyFixture = yield* makeWorld(`a${code}x`);

        const repositoryCommand = transactional(
          Effect.provideService(
            TeamsEndpoints.createMembership({
              end: NEXT_AUTUMN,
              leader: false,
              personId: repoFixture.person.id,
              positionId: repoFixture.memberPosition,
              start: CURRENT,
              teamId: repoFixture.team.id,
            }),
            CurrentPrincipal,
            adminFor(repoFixture.person.id)
          )
        );

        const alchemyCommand = Effect.gen(function* alchemyCommand() {
          const facts = yield* factsOf("createMembership", {
            positionId: alchemyFixture.memberPosition,
            target: String(alchemyFixture.person.id),
            teamId: alchemyFixture.team.id,
          });

          return yield* people
            .send(
              PersonKey.make(String(alchemyFixture.person.id)),
              new CreateMembership({
                end: NEXT_AUTUMN,
                leader: false,
                membershipId: yield* nextMembershipId,
                positionId: alchemyFixture.memberPosition,
                start: CURRENT,
                teamId: alchemyFixture.team.id,
              }),
              { commandId: `latency-${sample}` }
            )
            .pipe(
              Effect.provideService(
                RequestPrincipal,
                adminFor(alchemyFixture.person.id)
              ),
              Effect.provideService(CommandFacts, facts)
            );
        });

        const timings = yield* measureInOrder(
          repositoryCommand,
          alchemyCommand,
          isRepositoryFirst(sample)
        );

        if (sample > WARMUP_SAMPLES) {
          repositoryTimes.push(timings.repositoryElapsed);
          alchemyTimes.push(timings.alchemyElapsed);
        }
      }

      assert.strictEqual(repositoryTimes.length, TIMED_SAMPLES);
      assert.strictEqual(alchemyTimes.length, TIMED_SAMPLES);

      yield* Effect.logInfo(
        `PostgreSQL createMembership (${TIMED_SAMPLES} samples after ${
          WARMUP_SAMPLES
        } warmups): repository ${summary(
          repositoryTimes
        )}; Alchemy command returned with transactional projection ${summary(
          alchemyTimes
        )}`
      );

      return yield* Effect.void;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          modelWorld,
          Logger.layer([Logger.consoleJson]),
          Layer.succeed(References.MinimumLogLevel, "Info")
        )
      )
    )
);
