/**
 * The renewal's command on a real PostgreSQL, without a runtime: the same `extendMembership` that the Worker's task
 * runs, through the real `Person` aggregate, `StaffingModel` and the PostgreSQL platform, on a disposable database
 * that holds the repository's migrations and the spike's tables.
 */
import { assert, layer } from "@effect/vitest";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import { MembershipId } from "@vektorprogrammet/domain";
import { Cause, Effect, Exit, Predicate } from "effect";

import { extendMembership, staffingLayer } from "../src/extendMembership.ts";
import { decodeInput, extendCommandId } from "../src/renewal.ts";
import { freshTag, ledgerOf, newFixture, world } from "./support/world.ts";
import type { Fixture } from "./support/world.ts";

/** The renewal of `fixture` due in a fortnight, as the Worker decodes it; `membershipId` overrides the membership. */
const renewalOf = (fixture: Fixture, renewalId: string, membershipId: number) =>
  decodeInput({
    actorId: fixture.personId,
    dueAt: "2026-10-27T12:00:00.000Z",
    end: fixture.extendedEnd,
    membershipId,
    personId: fixture.personId,
    renewalId,
  });

layer(world, { timeout: "2 minutes" })(
  "ExtendMembership through the Person command path, on PostgreSQL",
  (it) => {
    it.effect(
      "commits once; the same command id again is answered from the receipt, not decided again",
      () =>
        Effect.gen(function* commitsOnce() {
          const tag = yield* freshTag;
          const fixture = yield* newFixture(tag);
          const url = yield* TestDatabaseUrl;

          const input = yield* renewalOf(
            fixture,
            `unit-${tag}`,
            fixture.membershipId
          );

          const commandId = extendCommandId(input.renewalId);

          const first = yield* extendMembership(input, 1).pipe(
            Effect.provide(staffingLayer(url))
          );

          const again = yield* extendMembership(input, 2).pipe(
            Effect.provide(staffingLayer(url))
          );

          assert.isTrue(Predicate.isTagged(first, "Extended"));
          assert.isTrue(Predicate.isTagged(again, "Extended"));

          if (
            Predicate.isTagged(first, "Extended") &&
            Predicate.isTagged(again, "Extended")
          ) {
            assert.strictEqual(first.commandId, commandId);
            assert.strictEqual(again.commandId, commandId);
            assert.strictEqual(first.version, again.version);
            assert.strictEqual(first.attempt, 1);
            assert.strictEqual(again.attempt, 2);
          }

          assert.deepStrictEqual(
            yield* ledgerOf(fixture, commandId, `unit-${tag}`),
            {
              extensions: 1,
              notices: 0,
              projectedEnd: fixture.extendedEnd,
              receipts: 1,
            }
          );
        })
    );

    it.effect(
      "a membership the person does not have is a Refusal, and writes nothing",
      () =>
        Effect.gen(function* refusesUnknownMembership() {
          const tag = yield* freshTag;
          const fixture = yield* newFixture(tag);
          const url = yield* TestDatabaseUrl;
          const missing = MembershipId.make(fixture.membershipId + 1_000_000);
          const input = yield* renewalOf(fixture, `missing-${tag}`, missing);

          const answered = yield* extendMembership(input, 1).pipe(
            Effect.provide(staffingLayer(url))
          );

          assert.isTrue(Predicate.isTagged(answered, "Refusal"));
          assert.deepStrictEqual(
            yield* ledgerOf(
              fixture,
              extendCommandId(input.renewalId),
              `missing-${tag}`
            ),
            {
              extensions: 0,
              notices: 0,
              projectedEnd: fixture.end,
              receipts: 0,
            }
          );
        })
    );
  }
);

layer(migratedTestDatabase, { timeout: "2 minutes" })(
  "the Worker's command on a database without the platform tables",
  (it) => {
    it.effect(
      "dies loudly: the Worker creates nothing, the test's initializer does",
      () =>
        Effect.gen(function* diesWithoutTables() {
          const url = yield* TestDatabaseUrl;
          const tag = yield* freshTag;

          const input = yield* decodeInput({
            actorId: 1,
            dueAt: "2026-10-27T12:00:00.000Z",
            end: { term: "HOST", year: 2027 },
            membershipId: 1,
            personId: 1,
            renewalId: `bare-${tag}`,
          });

          const exit = yield* Effect.exit(
            extendMembership(input, 1).pipe(Effect.provide(staffingLayer(url)))
          );

          assert.isTrue(Exit.isFailure(exit));

          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasDies(exit.cause));
            assert.isTrue(
              Predicate.isTagged(
                Cause.squash(exit.cause),
                "PlatformTablesMissing"
              )
            );
          }
        })
    );
  }
);
