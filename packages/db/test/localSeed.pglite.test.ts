/**
 * The local seed (`support/localSeed.ts`): the people the local test actor can be, with the facts their
 * principals are built from. It runs on an empty database (it makes its own department) and twice over changes
 * nothing.
 */
import { assert, layer } from "@effect/vitest";
import {
  LOCAL_PEOPLE,
  PersonRepository,
  PrincipalDirectory,
  currentSemester,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import { pgliteDatabase } from "./support/database.ts";
import { seedLocal } from "./support/localSeed.ts";

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const principalOf = Effect.fnUntraced(function* principalOf(name: string) {
  const directory = yield* PrincipalDirectory;

  return yield* directory.byName(name, {
    current: yield* currentSemester,
    now: yield* DateTime.now,
  });
});

layer(pgliteDatabase)("the local seed on PGlite", (outerTest) => {
  outerTest.layer(TestClock.layer())((it) => {
    it.effect(
      "the seeded people are what their names say: an admin, a leader, members, a person without a team and one whose membership has ended",
      () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          yield* seedLocal;

          const found = yield* Effect.forEach(LOCAL_PEOPLE, (name) =>
            Effect.map(
              principalOf(name),
              (principal) => [name, principal] as const
            )
          );

          const summary = Arr.map(found, ([name, principal]) => [
            name,
            Option.exists(principal, (value) => value.adminUntil !== undefined),
            Option.match(principal, {
              onNone: () => "missing",
              onSome: (value) =>
                Arr.join(
                  Arr.map(
                    value.memberships,
                    (fact) =>
                      `${fact.function}${fact.leader ? " (leader)" : ""}`
                  ),
                  ", "
                ),
            }),
          ]);

          assert.deepStrictEqual(summary, [
            ["Ada Admin", true, ""],
            ["Lise Leder", false, "recruitment (leader)"],
            ["Mats Medlem", false, "recruitment"],
            ["Sofie Styre", false, "board"],
            ["Nora Nybegynner", false, ""],
            ["Eva Ekstern", false, ""],
          ]);
        })
    );

    it.effect("running the seed again changes nothing", () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
        yield* seedLocal;

        const people = yield* PersonRepository;
        const before = yield* people.list(null);
        const again = yield* seedLocal;

        assert.deepStrictEqual(yield* people.list(null), before);
        assert.strictEqual(again.people, LOCAL_PEOPLE.length);
        assert.strictEqual(before.length, LOCAL_PEOPLE.length);
      })
    );
  });
});
