/**
 * Terms by date (spec 0006, falsifier 5; ADR 0002) and the Membership machine (ADR 0007). A membership's state is
 * calculated from its term and the current semester and stored nowhere. The semester edges are written here in Oslo
 * wall-clock time, independent of `semesterWindow`, which `semester.test.ts` pins to RULE-022.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Order, Result, Schema } from "effect";

import {
  Machine,
  MembershipTerm,
  Teams,
  advanceSemester,
  defaultEnd,
  isBeforeSemester,
  membershipState,
  membershipStateAt,
  previousSemester,
  semesterOfOrdinal,
  semesterOrdinal,
} from "../../src/index.ts";
import type { MembershipState, Semester } from "../../src/index.ts";
import type { MembershipMoment } from "../../src/teams/declaration.ts";
import { YEARS, host, oslo, vaar } from "../support/calendar.ts";

const { MembershipMachine } = Teams;

/** The first and the last millisecond of a semester by the Oslo calendar: Vår is January to July, Høst August to December. */
const edges = (semester: Semester) =>
  semester.term === "VAR"
    ? {
        first: oslo(`${semester.year}-01-01T00:00:00`),
        last: DateTime.add(oslo(`${semester.year}-08-01T00:00:00`), {
          milliseconds: -1,
        }),
      }
    : {
        first: oslo(`${semester.year}-08-01T00:00:00`),
        last: DateTime.add(oslo(`${semester.year + 1}-01-01T00:00:00`), {
          milliseconds: -1,
        }),
      };

const SEMESTERS = Arr.flatMap(YEARS, (year) => [vaar(year), host(year)]);

describe("falsifier 5: terms by date", () => {
  it("falsifier 5: at the last instant of a semester a membership ending in it is Active; at the first instant of the next it is Ended", () => {
    for (const end of SEMESTERS) {
      const term = { end, start: advanceSemester(end, -1) };

      assert.strictEqual(
        membershipStateAt(term, edges(end).last),
        "Active",
        `${end.term} ${end.year}, last instant`
      );
      assert.strictEqual(
        membershipStateAt(term, edges(advanceSemester(end, 1)).first),
        "Ended",
        `${end.term} ${end.year}, first instant of the next semester`
      );
    }
  });

  it("falsifier 5: a membership starting in a semester is Planned at the last instant before it and Active at its first instant", () => {
    for (const start of SEMESTERS) {
      const term = { end: advanceSemester(start, 1), start };

      assert.strictEqual(
        membershipStateAt(term, edges(advanceSemester(start, -1)).last),
        "Planned"
      );
      assert.strictEqual(membershipStateAt(term, edges(start).first), "Active");
    }
  });

  it("falsifier 5: across the whole term the state is Active, and the clock changes of March and October change nothing", () => {
    for (const year of YEARS) {
      const term = { end: host(year), start: vaar(year) };

      for (const instant of [
        edges(vaar(year)).first,
        oslo(`${year}-03-29T12:00:00`),
        oslo(`${year}-07-31T23:59:59`),
        oslo(`${year}-08-01T00:00:00`),
        oslo(`${year}-10-25T12:00:00`),
        edges(host(year)).last,
      ]) {
        assert.strictEqual(
          membershipStateAt(term, instant),
          "Active",
          DateTime.formatIso(instant)
        );
      }
    }
  });

  it("the state is Planned before the start, Active from the start to the end, Ended after", () => {
    const term = { end: host(2026), start: vaar(2026) };

    const states = Arr.map(
      [host(2025), vaar(2026), host(2026), vaar(2027)],
      (current) => membershipState(term, current)
    );

    assert.deepStrictEqual(states, ["Planned", "Active", "Active", "Ended"]);
  });

  it("semesters are numbered in calendar order: Vår before Høst, one step each, and the numbering inverts", () => {
    for (const [index, semester] of SEMESTERS.entries()) {
      assert.deepStrictEqual(
        semesterOfOrdinal(semesterOrdinal(semester)),
        semester
      );

      const following = SEMESTERS[index + 1];

      if (following !== undefined) {
        assert.strictEqual(
          semesterOrdinal(following) - semesterOrdinal(semester),
          1
        );
        assert.isTrue(isBeforeSemester(semester, following));
        assert.deepStrictEqual(previousSemester(following), semester);
      }
    }
  });

  it("ADR 0002: a default term counts its start semester: one semester ends where it starts, two end the next", () => {
    assert.deepStrictEqual(defaultEnd(vaar(2026), 1), vaar(2026));
    assert.deepStrictEqual(defaultEnd(vaar(2026), 2), host(2026));
    assert.deepStrictEqual(defaultEnd(host(2026), 2), vaar(2027));
  });

  it("start ≤ end is a rule of the term itself", () => {
    const decode = Schema.decodeUnknownResult(MembershipTerm);

    assert.isTrue(
      Result.isSuccess(decode({ end: host(2026), start: vaar(2026) }))
    );
    assert.isTrue(
      Result.isSuccess(decode({ end: vaar(2026), start: vaar(2026) }))
    );
    assert.isTrue(
      Result.isFailure(decode({ end: vaar(2026), start: host(2026) }))
    );
  });
});

/** What the guards of the Membership machine read: a term of each state, with the current semester Høst 2026. */
const momentOf = (
  state: MembershipState,
  requested: Semester
): MembershipMoment => ({
  current: host(2026),
  requested,
  term: {
    Active: { end: vaar(2027), start: vaar(2026) },
    Ended: { end: vaar(2026), start: vaar(2025) },
    Planned: { end: vaar(2028), start: vaar(2027) },
  }[state],
});

const can = (
  command:
    | "createTeam"
    | "deleteMembership"
    | "endEarlyMembership"
    | "extendMembership",
  state: MembershipState,
  requested: Semester
) => Machine.can(MembershipMachine, command, state, momentOf(state, requested));

/**
 * The terms and semesters of a window at which the calculated changes do not lead from the state that `term.ts`
 * calculates to the state that it calculates one semester later. The clock one tick on is what a calculated guard is
 * asked about (effx spec 0032 R1); `requested` is read by none of them.
 */
const timeAgainstTerm = (calculated: typeof MembershipMachine.calculated) => {
  const window: readonly Semester[] = Arr.take(SEMESTERS, 12);

  const pairs = Arr.flatMap(window, (start: Semester) =>
    Arr.flatMap(
      Arr.filter(window, (end: Semester) => !isBeforeSemester(end, start)),
      (end: Semester) =>
        Arr.map(window, (current: Semester) => ({ current, end, start }))
    )
  );

  const wrong = Arr.flatMap(pairs, ({ current, end, start }) => {
    const term = { end, start };
    const next = advanceSemester(current, 1);
    const before = membershipState(term, current);
    const moment = { current: next, requested: next, term };

    const changes = Arr.filter(
      calculated,
      (change) => change.from === before && change.accepts(moment)
    );

    const reached = changes[0]?.to ?? before;

    return changes.length <= 1 && reached === membershipState(term, next)
      ? []
      : [
          `${before} at ${semesterOrdinal(current)}, term ${semesterOrdinal(start)} to ${semesterOrdinal(end)}`,
        ];
  });

  return { compared: pairs.length, wrong };
};

describe("the Membership machine (ADR 0007)", () => {
  it("states are Planned, Active and Ended; the changes that time makes are declared", () => {
    assert.deepStrictEqual(Arr.sort(MembershipMachine.states, Order.String), [
      "Active",
      "Ended",
      "Planned",
    ]);
    assert.deepStrictEqual(
      Arr.map(MembershipMachine.calculated, ({ from, to }) => `${from}→${to}`),
      ["Planned→Active", "Active→Ended"]
    );
  });

  it("the changes that time makes are exactly how the state of term.ts moves in one semester, for every term and semester of a window", () => {
    const found = timeAgainstTerm(MembershipMachine.calculated);

    assert.deepStrictEqual(found.wrong, []);
    // every pair of a start and an end that is not before it (78 of 12 semesters), against each of the 12 currents
    assert.strictEqual(found.compared, 78 * 12);
  });

  it("negative control: an end that never arrives, or a start that always has, is not how term.ts moves", () => {
    const [start, end] = MembershipMachine.calculated;

    assert.isDefined(start);
    assert.isDefined(end);

    const neverEnds = Arr.map(MembershipMachine.calculated, (change) =>
      change === end ? { ...change, accepts: () => false } : change
    );

    const alwaysStarted = Arr.map(MembershipMachine.calculated, (change) =>
      change === start ? { ...change, accepts: () => true } : change
    );

    assert.isAbove(timeAgainstTerm(neverEnds).wrong.length, 0);
    assert.isAbove(timeAgainstTerm(alwaysStarted).wrong.length, 0);
  });

  it("extendMembership: only an Active membership, and only to a later end", () => {
    assert.isTrue(can("extendMembership", "Active", host(2027)));
    assert.isFalse(can("extendMembership", "Active", vaar(2027)));
    assert.isFalse(can("extendMembership", "Active", vaar(2026)));
    assert.isFalse(can("extendMembership", "Planned", vaar(2030)));
    assert.isFalse(can("extendMembership", "Ended", vaar(2030)));
  });

  it("endEarlyMembership: an Active membership ends before a semester inside its term that is not in the past", () => {
    assert.isTrue(can("endEarlyMembership", "Active", host(2026)));
    assert.isTrue(can("endEarlyMembership", "Active", vaar(2027)));
    assert.isFalse(can("endEarlyMembership", "Active", vaar(2026)));
    assert.isFalse(can("endEarlyMembership", "Active", host(2027)));
    assert.isFalse(can("endEarlyMembership", "Ended", host(2026)));
    assert.isFalse(can("endEarlyMembership", "Planned", vaar(2028)));
  });

  it("deleteMembership: only a Planned membership", () => {
    assert.isTrue(can("deleteMembership", "Planned", vaar(2027)));
    assert.isFalse(can("deleteMembership", "Active", vaar(2027)));
    assert.isFalse(can("deleteMembership", "Ended", vaar(2027)));
  });

  it("a command that the machine does not declare is never allowed, in any state", () => {
    for (const state of MembershipMachine.states) {
      assert.isFalse(can("createTeam", state, host(2027)));
    }
  });

  it("startsFrom answers which controls a state offers, whatever the guards say", () => {
    const offered = (state: MembershipState) =>
      Arr.filter(
        [
          "deleteMembership",
          "changeMembership",
          "endEarlyMembership",
          "extendMembership",
        ] as const,
        (command) => Machine.startsFrom(MembershipMachine, command, state)
      );

    assert.deepStrictEqual(offered("Planned"), ["deleteMembership"]);
    assert.deepStrictEqual(offered("Active"), [
      "changeMembership",
      "endEarlyMembership",
      "extendMembership",
    ]);
    assert.deepStrictEqual(offered("Ended"), []);
    assert.isTrue(
      Machine.startsFrom(
        MembershipMachine,
        "createMembership",
        Machine.Boundary
      )
    );
  });
});
