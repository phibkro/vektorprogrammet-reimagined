/** RULE-248: the person lock, unique welcome ledger and both outbox rows share the membership transaction. */
import { assert, layer } from "@effect/vitest";
import {
  CurrentPrincipal,
  EmailAddress,
  PersonId,
  PersonRepository,
  Principal,
  SiteOrigin,
  TeamsEndpoints,
  TeamRepository,
  WelcomeLedger,
} from "@vektorprogrammet/domain";
import type { Person, Team } from "@vektorprogrammet/domain";
import { Array as Arr, Cause, DateTime, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { race } from "./support/race.ts";
import { placeMembership, semester, world } from "./support/teamsWorld.ts";

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const ADMIN = Principal.cases.Person.make({
  adminUntil: DateTime.makeUnsafe("2099-12-31T23:59:59Z"),
  memberships: [],
  personId: PersonId.make(2000),
});

const live = Layer.merge(
  postgresDatabase(),
  Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
);

const create = (person: Person, team: Team, start = semester("HOST", 2026)) =>
  TeamsEndpoints.createMembership({
    leader: false,
    personId: person.id,
    positionId: 2,
    start,
    teamId: team.id,
  }).pipe(Effect.provideService(CurrentPrincipal, ADMIN));

const countsFor = (person: Person) =>
  Effect.gen(function* welcomeCounts() {
    const sql = yield* SqlClient;

    const [ledger] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from welcome_ledger where person_id = ${person.id}`;

    const [mail] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from outbox where kind = 'Email' and payload ->> 'to' = ${person.email}`;

    const [memberships] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from membership where person_id = ${person.id}`;

    return [ledger?.n, mail?.n, memberships?.n];
  });

layer(live, { excludeTestServices: true })("RULE-248 on PostgreSQL", (it) => {
  it.layer(TestClock.layer())((clocked) => {
    clocked.effect(
      "twenty concurrent memberships in different teams, in 100 fresh rounds, commit one claim and two messages",
      () =>
        Effect.gen(function* concurrentWelcome() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));

          const { department, fieldOfStudy, team } =
            yield* world("welcome-race");

          const people = yield* PersonRepository;
          const repository = yield* TeamRepository;

          const others = yield* Effect.forEach(Arr.range(2, 20), (index) =>
            repository.create({
              defaultTerm: 2,
              departmentId: department.id,
              function: "recruitment",
              groupEmail: null,
              name: `Welcome team ${index}`,
            })
          );

          const teams = [team, ...others];

          for (const round of Arr.range(1, 100)) {
            const person = yield* people.create({
              email: EmailAddress.make(`welcome-${round}@example.org`),
              fieldOfStudyId: fieldOfStudy.id,
              name: `Welcome ${round}`,
            });

            const exits = yield* race(
              Arr.map(teams, (candidate) =>
                transactional(create(person, candidate))
              )
            );

            const failures = Arr.flatMap(exits, (exit) =>
              Exit.isFailure(exit) ? [Cause.pretty(exit.cause)] : []
            );

            assert.deepStrictEqual(
              failures,
              [],
              `round ${round}: ${Arr.join(failures, "\n")}`
            );
            assert.strictEqual(
              Arr.filter(exits, Exit.isSuccess).length,
              20,
              `round ${round}: ${Arr.join(failures, "\n")}`
            );
            assert.deepStrictEqual(
              yield* countsFor(person),
              [1, 2, 20],
              `round ${round}`
            );
          }
        }),
      { timeout: 120_000 }
    );

    clocked.effect(
      "rollback removes the membership, the claim and both queued messages",
      () =>
        Effect.gen(function* rollback() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const { person, team } = yield* world("welcome-rollback");

          const failed = yield* Effect.exit(
            transactional(
              Effect.andThen(create(person, team), Effect.fail("rollback"))
            )
          );

          assert.isTrue(Exit.isFailure(failed));
          assert.deepStrictEqual(yield* countsFor(person), [0, 0, 0]);
          yield* transactional(create(person, team));
          assert.deepStrictEqual(yield* countsFor(person), [1, 2, 1]);
        })
    );

    clocked.effect(
      "a pre-existing planned membership leaves a welcome claim when it is cancelled",
      () =>
        Effect.gen(function* legacyCancellation() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));

          const { person, team, memberPosition } =
            yield* world("welcome-legacy");

          const planned = semester("HOST", 2027);

          const existing = yield* placeMembership(
            {
              personId: person.id,
              positionId: memberPosition,
              teamId: team.id,
            },
            { end: planned, start: planned }
          );

          yield* transactional(
            TeamsEndpoints.deleteMembership({ id: existing.id }).pipe(
              Effect.provideService(CurrentPrincipal, ADMIN)
            )
          );
          assert.deepStrictEqual(yield* countsFor(person), [1, 0, 0]);
          yield* transactional(create(person, team, planned));
          assert.deepStrictEqual(yield* countsFor(person), [1, 0, 1]);
        })
    );

    clocked.effect(
      "negative control: without the ledger, cancellation followed by a new first membership sends the messages twice",
      () =>
        Effect.gen(function* noLedger() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const { person, team } = yield* world("welcome-control");

          const unsafeLedger = WelcomeLedger.of({
            claim: () => Effect.succeed(true),
          });

          const first = yield* transactional(
            create(person, team, semester("HOST", 2027))
          ).pipe(Effect.provideService(WelcomeLedger, unsafeLedger));

          yield* transactional(
            TeamsEndpoints.deleteMembership({ id: first.id }).pipe(
              Effect.provideService(CurrentPrincipal, ADMIN)
            )
          ).pipe(Effect.provideService(WelcomeLedger, unsafeLedger));
          yield* transactional(
            create(person, team, semester("HOST", 2027))
          ).pipe(Effect.provideService(WelcomeLedger, unsafeLedger));
          assert.deepStrictEqual(yield* countsFor(person), [0, 4, 1]);
        })
    );
  });
});
