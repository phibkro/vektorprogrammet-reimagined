import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import {
  END_BEFORE_START_MESSAGE,
  EVENT_BADGE_LABEL,
  FileKey,
  INVALID_URL_MESSAGE,
  REQUIRED_FIELD_MESSAGE,
  SemesterId,
  createSocialEvent,
  createSponsor,
  eventBadge,
  formatCountdown,
  listSponsorsForFooter,
  type DomainError,
  type PublicFile,
  type ValidationIssue,
} from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  TestServices,
  admin,
  asActor,
  at,
  failureTag,
  seed,
  table,
  teamMemberBergen,
} from "../support/inMemory.ts";

const LOGO = FileKey.make(`${"e".repeat(64)}.png`);
const DOCUMENT = FileKey.make(`${"f".repeat(64)}.bin`);

const file = (key: FileKey, contentType: PublicFile["contentType"]): PublicFile => ({
  key,
  name: "fil",
  contentType,
  size: 1,
  uploadedBy: null,
  legacyPath: null,
  uploadedAt: at("2026-01-01T00:00:00Z"),
});

const sponsorInput = {
  name: "Eksempel AS",
  url: "https://example.org",
  size: "large",
  logoKey: null,
};

const issuesOf = (error: DomainError): ReadonlyArray<ValidationIssue> =>
  error._tag === "ValidationFailed" ? error.issues : [];

describe("C6 sponsors", () => {
  it.effect("RULE-189: an empty URL is rejected with 'Feletet kan ikke være tomt.'", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(createSponsor({ ...sponsorInput, url: "" })),
      );
      assert.strictEqual(error._tag, "ValidationFailed");
      assert.deepStrictEqual(issuesOf(error), [{ path: ["url"], message: REQUIRED_FIELD_MESSAGE }]);
      assert.deepStrictEqual(yield* table((db) => db.sponsors), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-189: name and size are required too", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          createSponsor({ url: "https://example.org", name: " ", logoKey: null }),
        ),
      );
      assert.deepStrictEqual(
        Object.fromEntries(issuesOf(error).map((issue) => [issue.path.join("."), issue.message])),
        { name: REQUIRED_FIELD_MESSAGE, size: REQUIRED_FIELD_MESSAGE },
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-189: the URL format is checked (legacy defect fixed)", () =>
    Effect.gen(function* () {
      for (const url of [
        "ikke en url",
        "javascript:alert(1)",
        "ftp://example.org",
        "https://localhost",
      ]) {
        const error = yield* Effect.flip(
          asActor(teamMemberBergen)(createSponsor({ ...sponsorInput, url })),
        );
        assert.deepStrictEqual(
          issuesOf(error),
          [{ path: ["url"], message: INVALID_URL_MESSAGE }],
          url,
        );
      }
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-189: the logo must be a registered image (legacy defect fixed)", () =>
    Effect.gen(function* () {
      yield* seed.publicFile(file(LOGO, "image/png"));
      yield* seed.publicFile(file(DOCUMENT, "application/octet-stream"));
      const rejected = yield* Effect.flip(
        asActor(teamMemberBergen)(createSponsor({ ...sponsorInput, logoKey: DOCUMENT })),
      );
      assert.strictEqual(rejected._tag, "ValidationFailed");
      const created = yield* asActor(teamMemberBergen)(
        createSponsor({ ...sponsorInput, logoKey: LOGO }),
      );
      assert.strictEqual(created.logoKey, LOGO);
      const audit = yield* table((db) => db.audit);
      assert.deepStrictEqual(
        audit.map((e) => e.action),
        ["sponsor.created"],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-189: a valid sponsor is saved; the footer lists large, medium, small", () =>
    Effect.gen(function* () {
      for (const [name, size] of [
        ["Liten", "small"],
        ["Stor", "large"],
        ["Middels", "medium"],
      ] as const) {
        yield* asActor(admin)(createSponsor({ ...sponsorInput, name, size }));
      }
      const footer = yield* listSponsorsForFooter;
      assert.deepStrictEqual(
        footer.map((s) => s.size),
        ["large", "medium", "small"],
      );
    }).pipe(Effect.provide(TestServices)),
  );
});

describe("C8 social events", () => {
  const eventInput = {
    title: "Julebord",
    description: "Velkommen!",
    startsAt: "2026-12-05T17:00:00.000Z",
    endsAt: "2026-12-05T23:00:00.000Z",
    link: null,
    departmentId: BERGEN,
    semesterId: SemesterId.make(5),
  };

  it.effect("RULE-188: a blank title is rejected", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(createSocialEvent({ ...eventInput, title: "  " })),
      );
      assert.deepStrictEqual(issuesOf(error), [
        { path: ["title"], message: REQUIRED_FIELD_MESSAGE },
      ]);
      assert.deepStrictEqual(yield* table((db) => db.socialEvents), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-188: the link is at most 250 characters", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          createSocialEvent({ ...eventInput, link: `https://example.org/${"x".repeat(240)}` }),
        ),
      );
      assert.deepStrictEqual(
        issuesOf(error).map((i) => i.path.join(".")),
        ["link"],
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-188: the end must be after the start (legacy defect fixed)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        asActor(teamMemberBergen)(
          createSocialEvent({ ...eventInput, endsAt: eventInput.startsAt }),
        ),
      );
      assert.deepStrictEqual(issuesOf(error), [
        { path: ["endsAt"], message: END_BEFORE_START_MESSAGE },
      ]);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect(
    "RULE-188: a titled event is saved for the chosen region and semester; no role field",
    () =>
      Effect.gen(function* () {
        const created = yield* asActor(teamMemberBergen)(
          createSocialEvent({ ...eventInput, role: "ROLE_ADMIN" }),
        );
        assert.strictEqual(created.departmentId, BERGEN);
        assert.strictEqual(created.semesterId, 5);
        assert.isFalse("role" in created);
        const audit = yield* table((db) => db.audit);
        assert.deepStrictEqual(
          audit.map((e) => e.action),
          ["socialEvent.created"],
        );
      }).pipe(Effect.provide(TestServices)),
  );

  it.effect("social events are scoped to the staff member's own department", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        asActor(teamMemberBergen)(createSocialEvent({ ...eventInput, departmentId: TRONDHEIM })),
      );
      assert.strictEqual(failureTag(exit), "Forbidden");
    }).pipe(Effect.provide(TestServices)),
  );

  it("RULE-085: yesterday 'Har vært', in 3 days 'Skjer innen en uke', in 8 days no badge", () => {
    const now = at("2026-10-15T10:00:00Z");
    const startingIn = (days: number) => ({ startsAt: DateTime.add(now, { days }) });
    assert.strictEqual(eventBadge(startingIn(-1), now), "HasHappened");
    assert.strictEqual(eventBadge(startingIn(3), now), "WithinAWeek");
    assert.strictEqual(eventBadge(startingIn(8), now), "None");
    assert.strictEqual(EVENT_BADGE_LABEL[eventBadge(startingIn(-1), now)], "Har vært");
    assert.strictEqual(EVENT_BADGE_LABEL[eventBadge(startingIn(3), now)], "Skjer innen en uke");
    assert.isNull(EVENT_BADGE_LABEL[eventBadge(startingIn(8), now)]);
  });

  it("RULE-085: the week boundary is exclusive and starting now is not 'has happened'", () => {
    const now = at("2026-10-15T10:00:00Z");
    assert.strictEqual(eventBadge({ startsAt: now }, now), "WithinAWeek");
    assert.strictEqual(eventBadge({ startsAt: DateTime.add(now, { days: 7 }) }, now), "None");
  });
});

describe("C3 home page", () => {
  const now = at("2026-10-15T10:00:00Z");
  const after = (parts: { days?: number; hours?: number; minutes?: number; seconds?: number }) =>
    DateTime.add(now, parts);

  it("RULE-070: 2 days 3 h 4 min 5 s shows '02d 03t 04m 05s'", () => {
    assert.strictEqual(
      formatCountdown(now, after({ days: 2, hours: 3, minutes: 4, seconds: 5 })),
      "02d 03t 04m 05s",
    );
  });

  it("RULE-070: 100 days or more are not truncated (legacy defect fixed)", () => {
    assert.strictEqual(formatCountdown(now, after({ days: 150, seconds: 1 })), "150d 00t 00m 01s");
  });

  it("RULE-070: a past end shows zeros", () => {
    assert.strictEqual(
      formatCountdown(now, DateTime.subtract(now, { hours: 1 })),
      "00d 00t 00m 00s",
    );
  });
});
