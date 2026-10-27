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
import type { Person, PositionId, Team } from "@vektorprogrammet/domain";
import { Array as Arr, Cause, DateTime, Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { mergeAs } from "./support/personalDataActors.ts";
import { nothing, seedPerson } from "./support/personData.ts";
import { race } from "./support/race.ts";
import {
  placeMembership,
  semester,
  twoPeople,
  world,
} from "./support/teamsWorld.ts";
import { countsFor } from "./support/welcomeCounts.ts";

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");
const LATER = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

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

/** A semester that has not started: a membership planned in it is cancelled before anything happens. */
const PLANNED = semester("HOST", 2027);

/** A planned membership that is cancelled again: the person keeps their welcome claim and holds no membership. */
const cancelledPlan = Effect.fnUntraced(function* cancelledPlan(
  person: Person,
  team: Team,
  positionId: PositionId
) {
  const existing = yield* placeMembership(
    { personId: person.id, positionId, teamId: team.id },
    { end: PLANNED, start: PLANNED }
  );

  yield* transactional(
    TeamsEndpoints.deleteMembership({ id: existing.id }).pipe(
      Effect.provideService(CurrentPrincipal, ADMIN)
    )
  );
});

/**
 * An administrator and two people of one department, the first of whom has a claim and no membership (a cancelled plan):
 * the second survives the merge.
 */
const mergePair = Effect.fnUntraced(function* mergePair(tag: string) {
  yield* TestClock.setTime(DateTime.toEpochMillis(LATER));

  const admin = yield* seedPerson(
    `${tag}-admin`,
    { ...nothing, account: true, grant: true },
    LATER
  );

  const { fieldOfStudy, team, memberPosition } = yield* world(tag);
  const [merged, survivor] = yield* twoPeople(fieldOfStudy.id, tag);
  yield* cancelledPlan(merged, team, memberPosition);

  return { admin: admin.personId, merged, survivor, team };
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
            transactional(
              repository.create({
                defaultTerm: 2,
                departmentId: department.id,
                function: "recruitment",
                groupEmail: null,
                name: `Welcome team ${index}`,
              })
            )
          );

          const teams = [team, ...others];

          for (const round of Arr.range(1, 100)) {
            const person = yield* transactional(
              people.create({
                email: EmailAddress.make(`welcome-${round}@example.org`),
                fieldOfStudyId: fieldOfStudy.id,
                name: `Welcome ${round}`,
              })
            );

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

          yield* cancelledPlan(person, team, memberPosition);
          assert.deepStrictEqual(yield* countsFor(person), [1, 0, 0]);
          yield* transactional(create(person, team, PLANNED));
          assert.deepStrictEqual(yield* countsFor(person), [1, 0, 1]);
        })
    );

    clocked.effect(
      "cancel, merge, then a new first membership for the survivor welcomes them once: the merged record's claim is kept",
      () =>
        Effect.gen(function* cancelMergeCreate() {
          const { admin, merged, survivor, team } =
            yield* mergePair("welcome-merge");

          assert.deepStrictEqual(yield* countsFor(merged), [1, 0, 0]);
          assert.deepStrictEqual(yield* countsFor(survivor), [0, 0, 0]);

          yield* mergeAs(admin, survivor.id, merged.id);
          assert.deepStrictEqual(yield* countsFor(merged), [0, 0, 0]);
          assert.deepStrictEqual(yield* countsFor(survivor), [1, 0, 0]);

          yield* transactional(create(survivor, team, PLANNED));
          assert.deepStrictEqual(yield* countsFor(survivor), [1, 0, 1]);
        })
    );

    clocked.effect(
      "a merge of two records that both hold a claim leaves the survivor one claim and queues nothing",
      () =>
        Effect.gen(function* bothClaims() {
          const { admin, merged, survivor, team } =
            yield* mergePair("welcome-both");

          yield* transactional(create(survivor, team, PLANNED));
          assert.deepStrictEqual(yield* countsFor(merged), [1, 0, 0]);
          assert.deepStrictEqual(yield* countsFor(survivor), [1, 2, 1]);

          yield* mergeAs(admin, survivor.id, merged.id);
          assert.deepStrictEqual(yield* countsFor(merged), [0, 0, 0]);
          assert.deepStrictEqual(yield* countsFor(survivor), [1, 2, 1]);
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
