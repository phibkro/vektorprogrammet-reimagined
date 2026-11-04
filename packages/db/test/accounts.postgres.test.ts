/** Spec 0007 falsifiers 2 and 4: real PostgreSQL code concurrency, expiry, scope and account states. */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  AccountRepository,
  CodeRepository,
  CurrentPrincipal,
  EmailAddress,
  PersonId,
  PersonRepository,
  Principal,
  authorize,
  codePrincipal,
  mintCode,
} from "@vektorprogrammet/domain";
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
import { activeAdmin } from "./support/accountsWorld.ts";
import { issueUsable } from "./support/codes.ts";
import { postgresDatabase } from "./support/database.ts";
import { raceReport } from "./support/race.ts";
import { asPerson, lockPerson, world } from "./support/teamsWorld.ts";

const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const beforeExpiry = DateTime.makeUnsafe("2098-12-31T23:59:59.999Z");

const RACE_ROUNDS = 300;

layer(postgresDatabase().pipe(Layer.provideMerge(NodeServices.layer)), {
  excludeTestServices: true,
})("Person locks, alumni codes and last administrators on PostgreSQL", (it) => {
  it.effect(
    "100 rounds: a Person aggregate lock holds until transaction completion",
    () =>
      Effect.gen(function* personLockProperty() {
        const fixture = yield* world("person-lock");
        const people = yield* PersonRepository;
        const sql = yield* SqlClient;

        for (const round of Arr.range(1, 100)) {
          const person = yield* transactional(
            people.create({
              email: EmailAddress.make(`lock-${round}@example.org`),
              fieldOfStudyId: fixture.fieldOfStudy.id,
              name: `Person lock ${round}`,
            })
          );

          const locked = yield* Deferred.make<null>();
          const release = yield* Deferred.make<null>();

          const holder = yield* Effect.forkChild(
            transactional(
              Effect.gen(function* holdPersonLock() {
                const found = yield* lockPerson(person.id);
                yield* Deferred.succeed(locked, null);
                yield* Deferred.await(release);

                return found.id === person.id;
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

          const report = raceReport<unknown, unknown>(round, [
            competitor,
            held,
          ]);

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
    "alumni consent codes are reusable, scoped, expire and are replaced",
    () =>
      Effect.gen(function* alumniCodeBoundaries() {
        const fixture = yield* world("code-boundary");
        const other = yield* world("code-other");
        const codes = yield* CodeRepository;
        const first = yield* mintCode().pipe(Effect.orDie);
        const second = yield* mintCode().pipe(Effect.orDie);

        const replace = (hash: typeof first.hash) =>
          asPerson(fixture.person.id, (locked) =>
            issueUsable(locked, { expiresAt, hash, purpose: "alumniConsent" })
          );

        const request = {
          hash: first.hash,
          now: beforeExpiry,
          purpose: "alumniConsent",
        } as const;

        yield* replace(first.hash);
        assert.isTrue(Option.isSome(yield* codes.findUsable(request)));
        assert.isTrue(
          Option.isNone(yield* codes.findUsable({ ...request, now: expiresAt }))
        );
        const principal = yield* codePrincipal(first.token, "alumniConsent");
        assert.isTrue(Option.isSome(principal));

        if (Option.isSome(principal)) {
          assert.isTrue(
            authorize(principal.value, "answerAlumniConsent", {
              personId: fixture.person.id,
            })
          );
          assert.isFalse(
            authorize(principal.value, "answerAlumniConsent", {
              personId: other.person.id,
            })
          );
          assert.isFalse(
            authorize(principal.value, "deactivateAccount", {
              personId: fixture.person.id,
            })
          );
        }

        assert.isTrue(
          Option.isSome(yield* codePrincipal(first.token, "alumniConsent"))
        );
        yield* replace(second.hash);
        assert.isTrue(
          Option.isNone(yield* codePrincipal(first.token, "alumniConsent"))
        );
        assert.isTrue(
          Option.isSome(yield* codePrincipal(second.token, "alumniConsent"))
        );
      })
  );
  it.effect(
    "RULE-202: 300 rounds of racing deactivations preserve the last Active admin",
    () =>
      Effect.gen(function* lastAdminRace() {
        const fixture = yield* world("admin-race");
        const accounts = yield* AccountRepository;
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
              transactional(
                people.create({
                  email: EmailAddress.make(
                    `admin-${round}-${side}@example.org`
                  ),
                  fieldOfStudyId: fixture.fieldOfStudy.id,
                  name: `Admin ${round} ${side}`,
                })
              )
          );

          for (const person of pair) {
            yield* activeAdmin(person.id, expiresAt);
          }

          const outcomes = yield* Effect.all(
            Arr.map(pair, (person) =>
              Effect.exit(
                transactional(
                  AccountEndpoints.deactivateAccount({
                    personId: person.id,
                  }).pipe(Effect.provideService(CurrentPrincipal, actor))
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
