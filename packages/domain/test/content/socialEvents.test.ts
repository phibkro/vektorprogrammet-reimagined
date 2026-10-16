import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Effect, Predicate } from "effect";

import {
  END_BEFORE_START_MESSAGE,
  EVENT_BADGE_LABEL,
  REQUIRED_FIELD_MESSAGE,
  SemesterId,
  createSocialEvent,
  eventBadge,
} from "../../src/index.ts";
import type { DomainError, ValidationIssue } from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  TestServices,
  asActor,
  at,
  auditActions,
  failureTag,
  table,
  teamMemberBergen,
} from "../support/inMemory.ts";

const issuesOf = (error: DomainError): readonly ValidationIssue[] =>
  Predicate.isTagged(error, "ValidationFailed") ? error.issues : [];

describe("C8 social events", () => {
  const eventInput = {
    departmentId: BERGEN,
    description: "Velkommen!",
    endsAt: "2026-12-05T23:00:00.000Z",
    link: null,
    semesterId: SemesterId.make(5),
    startsAt: "2026-12-05T17:00:00.000Z",
    title: "Julebord",
  };

  it.effect("RULE-188: a blank title is rejected", () =>
    Effect.gen(function* effectProgram() {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          createSocialEvent({ ...eventInput, title: "  " })
        )
      );

      assert.deepStrictEqual(issuesOf(error), [
        { message: REQUIRED_FIELD_MESSAGE, path: ["title"] },
      ]);
      assert.deepStrictEqual(yield* table((db) => db.socialEvents), []);
    }).pipe(Effect.provide(TestServices))
  );

  it.effect("RULE-188: the link is at most 250 characters", () =>
    Effect.gen(function* effectProgram() {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          createSocialEvent({
            ...eventInput,
            link: `https://example.org/${"x".repeat(240)}`,
          })
        )
      );

      assert.deepStrictEqual(
        Arr.map(issuesOf(error), (i) => Arr.join(i.path, ".")),
        ["link"]
      );
    }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-188: the end must be after the start (legacy defect fixed)",
    () =>
      Effect.gen(function* effectProgram() {
        const error = yield* Effect.flip(
          asActor(teamMemberBergen)(
            createSocialEvent({ ...eventInput, endsAt: eventInput.startsAt })
          )
        );

        assert.deepStrictEqual(issuesOf(error), [
          { message: END_BEFORE_START_MESSAGE, path: ["endsAt"] },
        ]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-188: a titled event is saved for the chosen region and semester; no role field",
    () =>
      Effect.gen(function* effectProgram() {
        const created = yield* asActor(teamMemberBergen)(
          createSocialEvent({ ...eventInput, role: "ROLE_ADMIN" })
        );

        assert.strictEqual(created.departmentId, BERGEN);
        assert.strictEqual(created.semesterId, 5);
        assert.isFalse("role" in created);
        assert.deepStrictEqual(yield* auditActions, ["socialEvent.created"]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "social events are scoped to the staff member's own department",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* Effect.exit(
          asActor(teamMemberBergen)(
            createSocialEvent({ ...eventInput, departmentId: TRONDHEIM })
          )
        );

        assert.strictEqual(failureTag(exit), "Forbidden");
      }).pipe(Effect.provide(TestServices))
  );

  it("RULE-085: yesterday 'Har vært', in 3 days 'Skjer innen en uke', in 8 days no badge", () => {
    const now = at("2026-10-15T10:00:00Z");

    const startingIn = (days: number) => ({
      startsAt: DateTime.add(now, { days }),
    });

    assert.strictEqual(eventBadge(startingIn(-1), now), "HasHappened");
    assert.strictEqual(eventBadge(startingIn(3), now), "WithinAWeek");
    assert.strictEqual(eventBadge(startingIn(8), now), "None");
    assert.strictEqual(
      EVENT_BADGE_LABEL[eventBadge(startingIn(-1), now)],
      "Har vært"
    );
    assert.strictEqual(
      EVENT_BADGE_LABEL[eventBadge(startingIn(3), now)],
      "Skjer innen en uke"
    );
    assert.isNull(EVENT_BADGE_LABEL[eventBadge(startingIn(8), now)]);
  });

  it("RULE-085: the week boundary is exclusive and starting now is not 'has happened'", () => {
    const now = at("2026-10-15T10:00:00Z");
    assert.strictEqual(eventBadge({ startsAt: now }, now), "WithinAWeek");
    assert.strictEqual(
      eventBadge({ startsAt: DateTime.add(now, { days: 7 }) }, now),
      "None"
    );
  });
});
