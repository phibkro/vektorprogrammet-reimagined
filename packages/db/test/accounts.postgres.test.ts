/** Spec 0007 falsifiers 2 and 4: real PostgreSQL code concurrency, expiry, scope and account states. */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  AccountRepository,
  AdminGrantRepository,
  CodeRepository,
  CurrentPrincipal,
  EmailAddress,
  PasswordHasher,
  PersonId,
  PersonRepository,
  Principal,
  authorize,
  codePrincipal,
  mintCode,
} from "@vektorprogrammet/domain";
import type { CodePurpose } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { world } from "./support/teamsWorld.ts";

const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const beforeExpiry = DateTime.makeUnsafe("2098-12-31T23:59:59.999Z");
const now = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");

const RACE_ROUNDS = 300;

/** Retain every failed fiber's full Cause in the assertion, including SQL defects. */
const raceReport = <A, E>(
  round: number,
  exits: readonly Exit.Exit<A, E>[]
): string =>
  `round ${round}:\n${Arr.join(
    Arr.map(Arr.filter(exits, Exit.isFailure), (failure) =>
      Cause.pretty(failure.cause)
    ),
    "\n\n"
  )}`;

type AccountStateName = "Invited" | "Active" | "Deactivated";

const assertAuthority = (
  principal: Principal,
  purpose: CodePurpose,
  personId: PersonId
) => {
  const command = purpose === "activation" ? "activate" : "resetPassword";
  const other = purpose === "activation" ? "resetPassword" : "activate";
  assert.isTrue(authorize(principal, command, { personId }));
  assert.isFalse(authorize(principal, other, { personId }));
  assert.isFalse(
    authorize(principal, command, { personId: PersonId.make(personId + 1) })
  );
  assert.isFalse(authorize(principal, "deactivate", { personId }));
};

const checkPurpose = Effect.fnUntraced(function* checkPurpose(
  personId: PersonId,
  state: AccountStateName,
  purpose: CodePurpose
) {
  const code = yield* mintCode().pipe(Effect.orDie);
  yield* (yield* CodeRepository).replace({
    expiresAt,
    hash: code.hash,
    purpose,
    subject: personId,
    usedAt: null,
  });
  const principal = yield* codePrincipal(code.token, purpose);

  const expected =
    (purpose === "activation" && state === "Invited") ||
    (purpose === "resetPassword" && state === "Active");

  assert.strictEqual(Option.isSome(principal), expected);

  if (Option.isSome(principal)) {
    assertAuthority(principal.value, purpose, personId);
  }
});

layer(
  Layer.merge(
    postgresDatabase().pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.mock(PasswordHasher, {})
  ),
  {
    excludeTestServices: true,
  }
)("RULE-131, 132, 201, 220: single-use credentials on PostgreSQL", (it) => {
  it.effect(
    "100 rounds: a Person aggregate lock holds until transaction completion",
    () =>
      Effect.gen(function* personLockProperty() {
        const fixture = yield* world("person-lock");
        const accounts = yield* AccountRepository;
        const people = yield* PersonRepository;
        const sql = yield* SqlClient;

        for (const round of Arr.range(1, 100)) {
          const person = yield* people.create({
            email: EmailAddress.make(`lock-${round}@example.org`),
            fieldOfStudyId: fixture.fieldOfStudy.id,
            name: `Person lock ${round}`,
          });

          const locked = yield* Deferred.make<null>();
          const release = yield* Deferred.make<null>();

          const holder = yield* Effect.forkChild(
            transactional(
              Effect.gen(function* holdPersonLock() {
                const found = yield* accounts.lockPerson(person.id);
                yield* Deferred.succeed(locked, null);
                yield* Deferred.await(release);

                return found;
              })
            )
          );

          yield* Deferred.await(locked);

          const competitor = yield* Effect.exit(
            transactional(
              sql`select id from person where id = ${person.id} for no key update nowait`
            )
          );

          yield* Deferred.succeed(release, null);
          const held = yield* Fiber.await(holder);
          const report = raceReport<unknown, never>(round, [competitor, held]);
          assert.isTrue(Exit.isSuccess(held) && held.value, report);
          assert.isTrue(Exit.isFailure(competitor), report);

          if (Exit.isFailure(competitor)) {
            assert.include(
              Cause.pretty(competitor.cause),
              "could not obtain lock on row",
              report
            );
          }

          // With the holder gone the identical competing statement must succeed.
          const released =
            yield* sql`select id from person where id = ${person.id} for no key update nowait`;

          assert.strictEqual(released.length, 1, report);
        }
      }),
    120_000
  );

  it.effect(
    "300 rounds: 20 concurrent uses of each fresh code have exactly one winner",
    () =>
      Effect.gen(function* codeConcurrency() {
        const fixture = yield* world("code-race");
        const codes = yield* CodeRepository;

        for (const round of Arr.range(1, RACE_ROUNDS)) {
          const { hash } = yield* mintCode().pipe(Effect.orDie);
          yield* codes.replace({
            expiresAt,
            hash,
            purpose: "activation",
            subject: fixture.person.id,
            usedAt: null,
          });

          const uses = yield* Effect.all(
            Arr.makeBy(20, () =>
              Effect.exit(
                codes.consume({
                  hash,
                  now,
                  purpose: "activation",
                  subject: fixture.person.id,
                })
              )
            ),
            { concurrency: "unbounded" }
          );

          const report = raceReport(round, uses);
          assert.strictEqual(
            Arr.filter(uses, Exit.isFailure).length,
            0,
            report
          );
          assert.strictEqual(
            Arr.filter(uses, (exit) => Exit.isSuccess(exit) && exit.value)
              .length,
            1,
            report
          );
        }
      }),
    120_000
  );

  it.effect(
    "expiry is strict to the millisecond, scope is exact, and resend invalidates the older code",
    () =>
      Effect.gen(function* codeBoundaries() {
        const fixture = yield* world("code-boundary");
        const codes = yield* CodeRepository;
        const first = yield* mintCode().pipe(Effect.orDie);
        const second = yield* mintCode().pipe(Effect.orDie);

        const replace = (hash: typeof first.hash) =>
          codes.replace({
            expiresAt,
            hash,
            purpose: "activation",
            subject: fixture.person.id,
            usedAt: null,
          });

        yield* replace(first.hash);

        assert.isFalse(
          yield* codes.consume({
            hash: first.hash,
            now: beforeExpiry,
            purpose: "resetPassword",
            subject: fixture.person.id,
          })
        );
        assert.isFalse(
          yield* codes.consume({
            hash: first.hash,
            now: beforeExpiry,
            purpose: "activation",
            subject: PersonId.make(fixture.person.id + 1),
          })
        );
        assert.isFalse(
          yield* codes.consume({
            hash: first.hash,
            now: expiresAt,
            purpose: "activation",
            subject: fixture.person.id,
          })
        );
        assert.isTrue(
          yield* codes.consume({
            hash: first.hash,
            now: beforeExpiry,
            purpose: "activation",
            subject: fixture.person.id,
          })
        );
        yield* replace(first.hash);
        yield* replace(second.hash);
        assert.isFalse(
          yield* codes.consume({
            hash: first.hash,
            now,
            purpose: "activation",
            subject: fixture.person.id,
          })
        );
        assert.isTrue(
          yield* codes.consume({
            hash: second.hash,
            now,
            purpose: "activation",
            subject: fixture.person.id,
          })
        );
      })
  );

  it.effect(
    "each code principal has exactly its command, subject and transition state",
    () =>
      Effect.gen(function* codeStateProperty() {
        const fixture = yield* world("code-state");
        const accounts = yield* AccountRepository;
        yield* accounts.invite(fixture.person.id);

        for (const state of ["Invited", "Active", "Deactivated"] as const) {
          if (state === "Active") {
            yield* accounts.transition({
              from: "Invited",
              now,
              personId: fixture.person.id,
              prohibitLastActiveAdmin: false,
              to: "Active",
            });
          }

          if (state === "Deactivated") {
            yield* accounts.transition({
              from: "Active",
              now,
              personId: fixture.person.id,
              prohibitLastActiveAdmin: false,
              to: "Deactivated",
            });
          }

          yield* Effect.forEach(
            ["activation", "resetPassword"] satisfies readonly CodePurpose[],
            (purpose) => checkPurpose(fixture.person.id, state, purpose),
            { discard: true }
          );
        }
      })
  );
  it.effect(
    "RULE-202: 300 rounds of racing deactivations preserve the last Active admin",
    () =>
      Effect.gen(function* lastAdminRace() {
        const fixture = yield* world("admin-race");
        const accounts = yield* AccountRepository;
        const grants = yield* AdminGrantRepository;
        const people = yield* PersonRepository;
        const sql = yield* SqlClient;

        const actor = Principal.cases.Person.make({
          adminUntil: expiresAt,
          memberships: [],
          personId: PersonId.make(900_001),
        });

        for (const round of Arr.range(1, RACE_ROUNDS)) {
          const pair = yield* Effect.forEach(
            ["left", "right"] as const,
            (side) =>
              people.create({
                email: EmailAddress.make(`admin-${round}-${side}@example.org`),
                fieldOfStudyId: fixture.fieldOfStudy.id,
                name: `Admin ${round} ${side}`,
              })
          );

          for (const person of pair) {
            yield* accounts.invite(person.id);
            yield* accounts.transition({
              from: "Invited",
              now,
              personId: person.id,
              prohibitLastActiveAdmin: false,
              to: "Active",
            });
            yield* grants.create({
              grantedBy: null,
              personId: person.id,
              until: expiresAt,
            });
          }

          const outcomes = yield* Effect.all(
            Arr.map(pair, (person) =>
              Effect.exit(
                transactional(
                  AccountEndpoints.deactivate({ personId: person.id }).pipe(
                    Effect.provideService(CurrentPrincipal, actor)
                  )
                )
              )
            ),
            { concurrency: "unbounded" }
          );

          const report = raceReport(round, outcomes);
          const losers = Arr.filter(outcomes, Exit.isFailure);
          assert.strictEqual(
            Arr.filter(outcomes, Exit.isSuccess).length,
            1,
            report
          );
          assert.strictEqual(losers.length, 1, report);

          for (const loser of losers) {
            assert.isTrue(
              Option.exists(
                Exit.findErrorOption(loser),
                Predicate.isTagged("Conflict")
              ),
              report
            );
          }

          const states = yield* Effect.forEach(pair, (person) =>
            accounts.find(person.id)
          );

          assert.strictEqual(
            Arr.filter(
              states,
              (entry) =>
                Option.isSome(entry) &&
                Predicate.isTagged(entry.value.state, "Active")
            ).length,
            1,
            report
          );

          for (const person of pair) {
            yield* sql`delete from admin_grant where person_id = ${person.id}`;
            yield* sql`delete from account where person_id = ${person.id}`;
          }
        }
      }),
    120_000
  );
});
