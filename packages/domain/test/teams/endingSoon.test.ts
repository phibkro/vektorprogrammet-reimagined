/**
 * The "ending soon" digest (spec 0006, falsifier 7; ADR 0002): four weeks before a semester ends, one e-mail goes to
 * each team leader with the memberships of the department that end in it, each with a link to extend it. The job
 * runs as `System("endingSoon")` through `authorize`, on every cron tick, and a second run sends nothing.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Predicate,
} from "effect";
import { TestClock } from "effect/testing";

import {
  AuditPrincipal,
  DepartmentId,
  FieldOfStudyId,
  TeamsEndpoints,
  endingSoonJob,
  isEndingSoon,
  planDigests,
  systemPrincipal,
} from "../../src/index.ts";
import type { PersonId, Semester, TeamId } from "../../src/index.ts";
import { host, oslo, vaar } from "../support/calendar.ts";
import {
  BERGEN,
  SITE_ORIGIN,
  TRONDHEIM,
  TestServices,
  admin,
  asPrincipal,
  departmentForTest,
  failureTag,
  seed,
  table,
} from "../support/inMemory.ts";
import { LEADER_POSITION, MEMBER_POSITION } from "../support/teamsInMemory.ts";

const OSLO = DepartmentId.make(3);

const runJob = asPrincipal(systemPrincipal("endingSoon"))(endingSoonJob);

const at = (local: string) => DateTime.toEpochMillis(oslo(local));

describe("falsifier 7: the digest runs in the last four weeks of the semester", () => {
  it("the window opens four calendar weeks before the end instant, in Oslo time, and closes at the end", () => {
    const probes = [
      [host(2026), "2026-12-03T23:59:59", false],
      [host(2026), "2026-12-04T00:00:00", true],
      [host(2026), "2026-12-31T23:59:59", true],
      [host(2026), "2027-01-01T00:00:00", false],
      [vaar(2026), "2026-07-03T23:59:59", false],
      [vaar(2026), "2026-07-04T00:00:00", true],
      [vaar(2026), "2026-07-31T23:59:59", true],
      [vaar(2026), "2026-08-01T00:00:00", false],
    ] as const;

    for (const [semester, local, expected] of probes) {
      assert.strictEqual(
        isEndingSoon(semester, oslo(local)),
        expected,
        `${semester.term} ${semester.year} at ${local}`
      );
    }
  });

  it("a leader with nothing ending gets nothing, and nobody leads nothing", () => {
    assert.deepStrictEqual(planDigests([], host(2026)), []);
  });
});

const registerPerson = (name: string, fieldOfStudyId: FieldOfStudyId) =>
  asPrincipal(admin)(
    TeamsEndpoints.createPerson({
      email: `${name.toLowerCase()}@example.org`,
      fieldOfStudyId,
      name,
    })
  );

const createTeam = (departmentId: DepartmentId, name: string) =>
  asPrincipal(admin)(
    TeamsEndpoints.createTeam({
      defaultTerm: 2,
      departmentId,
      function: "recruitment",
      name,
    })
  );

const joinTeam = (
  teamId: TeamId,
  personId: PersonId,
  end: Semester,
  leader: boolean
) =>
  asPrincipal(admin)(
    TeamsEndpoints.createMembership({
      end,
      leader,
      personId,
      positionId: leader ? LEADER_POSITION : MEMBER_POSITION,
      start: host(2026),
      teamId,
    })
  );

const TRONDHEIM_FIELD = FieldOfStudyId.make(1);

const BERGEN_FIELD = FieldOfStudyId.make(2);

const OSLO_FIELD = FieldOfStudyId.make(3);

/**
 * Trondheim has two teams: Leif leads the first and ends this semester with Ola; Lars leads the second until spring;
 * Kari stays until spring. Bergen's Lise leads until spring, and Per ends this semester. Oslo has a leader, and
 * nothing ends there.
 */
const departments = Effect.gen(function* departments() {
  for (const [id, city, field] of [
    [TRONDHEIM, "Trondheim", TRONDHEIM_FIELD],
    [BERGEN, "Bergen", BERGEN_FIELD],
    [OSLO, "Oslo", OSLO_FIELD],
  ] as const) {
    yield* seed.department(departmentForTest(id, city));
    yield* seed.fieldOfStudy({
      departmentId: id,
      id: field,
      name: `Linje ${city}`,
      shortName: city.slice(0, 3),
    });
  }

  const now = host(2026);
  const spring = vaar(2027);
  const rekruttering = yield* createTeam(TRONDHEIM, "Rekruttering");
  const economy = yield* createTeam(TRONDHEIM, "Økonomi");
  const bergen = yield* createTeam(BERGEN, "Rekruttering");
  const osloTeam = yield* createTeam(OSLO, "Rekruttering");

  for (const [team, name, field, end, leader] of [
    [rekruttering, "Leif", TRONDHEIM_FIELD, now, true],
    [rekruttering, "Ola", TRONDHEIM_FIELD, now, false],
    [rekruttering, "Kari", TRONDHEIM_FIELD, spring, false],
    [economy, "Lars", TRONDHEIM_FIELD, spring, true],
    [bergen, "Lise", BERGEN_FIELD, spring, true],
    [bergen, "Per", BERGEN_FIELD, now, false],
    [osloTeam, "Olav", OSLO_FIELD, spring, true],
  ] as const) {
    const registered = yield* registerPerson(name, field);
    yield* joinTeam(team.id, registered.id, end, leader);
  }
});

const sentMail = Effect.map(
  table((db) => db.outbox),
  (messages) =>
    Arr.flatMap(messages, (message) =>
      Predicate.isTagged(message, "Email") ? [message] : []
    )
);

describe("falsifier 7: one message per leader, once", () => {
  it.effect(
    "falsifier 7: one run sends one message per leader who has something to read; a second run, and a later one in the same semester, send none",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(at("2026-10-01T12:00:00"));
        yield* departments;

        assert.deepStrictEqual(yield* runJob, { sent: 0 });
        assert.strictEqual((yield* sentMail).length, 0);

        yield* TestClock.setTime(at("2026-12-10T12:00:00"));
        assert.deepStrictEqual(yield* runJob, { sent: 3 });

        assert.deepStrictEqual(
          Arr.sort(
            Arr.map(yield* sentMail, (message) => message.to),
            Order.String
          ),
          ["lars@example.org", "leif@example.org", "lise@example.org"]
        );

        assert.deepStrictEqual(yield* runJob, { sent: 0 });

        yield* TestClock.setTime(at("2026-12-20T12:00:00"));
        assert.deepStrictEqual(yield* runJob, { sent: 0 });
        assert.strictEqual((yield* sentMail).length, 3);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "the message lists the department's memberships that end, each with the link to extend it; it is audited as the job",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(at("2026-12-10T12:00:00"));
        yield* departments;
        yield* runJob;

        const lise = Arr.findFirst(
          yield* sentMail,
          (message) => message.to === "lise@example.org"
        );

        assert.isTrue(
          Option.exists(
            lise,
            (message) =>
              message.text.includes("Per") &&
              !message.text.includes("Kari") &&
              message.text.includes(`${SITE_ORIGIN}/kontrollpanel/team/`) &&
              message.text.includes("?forleng=")
          )
        );

        assert.deepStrictEqual(
          Arr.map(
            Arr.filter(
              yield* table((db) => db.audit),
              (entry) => entry.action === "endingSoon.sent"
            ),
            (entry) => entry.principal
          ),
          Arr.replicate(
            AuditPrincipal.cases.System.make({ job: "endingSoon" }),
            3
          )
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "R1: the digest is the job's command: an admin and another job are refused, and nothing is sent",
    () =>
      Effect.gen(function* effectProgram() {
        yield* TestClock.setTime(at("2026-12-10T12:00:00"));
        yield* departments;

        const outcomes = yield* Effect.forEach(
          [admin, systemPrincipal("semesters")],
          (principal) => Effect.exit(asPrincipal(principal)(endingSoonJob))
        );

        assert.deepStrictEqual(Arr.map(outcomes, failureTag), [
          "Forbidden",
          "Forbidden",
        ]);
        assert.strictEqual((yield* sentMail).length, 0);
      }).pipe(Effect.provide(TestServices))
  );
});
