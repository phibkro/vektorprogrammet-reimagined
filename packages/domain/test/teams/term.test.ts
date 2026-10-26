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
  command: "cancel" | "createTeam" | "endEarly" | "extend",
  state: MembershipState,
  requested: Semester
) => Machine.can(MembershipMachine, command, state, momentOf(state, requested));

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

  it("extend: only an Active membership, and only to a later end", () => {
    assert.isTrue(can("extend", "Active", host(2027)));
    assert.isFalse(can("extend", "Active", vaar(2027)));
    assert.isFalse(can("extend", "Active", vaar(2026)));
    assert.isFalse(can("extend", "Planned", vaar(2030)));
    assert.isFalse(can("extend", "Ended", vaar(2030)));
  });

  it("endEarly: an Active membership ends before a semester inside its term that is not in the past", () => {
    assert.isTrue(can("endEarly", "Active", host(2026)));
    assert.isTrue(can("endEarly", "Active", vaar(2027)));
    assert.isFalse(can("endEarly", "Active", vaar(2026)));
    assert.isFalse(can("endEarly", "Active", host(2027)));
    assert.isFalse(can("endEarly", "Ended", host(2026)));
    assert.isFalse(can("endEarly", "Planned", vaar(2028)));
  });

  it("cancel: only a Planned membership", () => {
    assert.isTrue(can("cancel", "Planned", vaar(2027)));
    assert.isFalse(can("cancel", "Active", vaar(2027)));
    assert.isFalse(can("cancel", "Ended", vaar(2027)));
  });

  it("a command that the machine does not declare is never allowed, in any state", () => {
    for (const state of MembershipMachine.states) {
      assert.isFalse(can("createTeam", state, host(2027)));
    }
  });
});
