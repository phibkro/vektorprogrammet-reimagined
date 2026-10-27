/**
 * The laws of the kernel's `authorize` (spec 0006, ADR 0001), over the sample domain: deny by default, union only,
 * the scopes, the admin row, the system principals. The falsifier over the real grant table is
 * `test/teams/grants.test.ts`; both use the oracle of `support/grantLaws.ts`, which reads a table by a second route.
 */
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Array as Arr, Effect, Predicate } from "effect";

import {
  DepartmentId,
  Grant,
  PersonId,
  Subject,
  TeamId,
  anonymous,
  authorizeWith,
  systemPrincipal,
} from "../../src/index.ts";
import type { MembershipFact } from "../../src/index.ts";
import {
  agreement,
  cases,
  oracle,
  passes,
  principalOf,
  principals,
  resources,
  without,
} from "../support/grantLaws.ts";
import { Sample } from "./sample.ts";

const ONE = DepartmentId.make(1);

const TWO = DepartmentId.make(2);

const fact = (
  departmentId: DepartmentId,
  overrides: Partial<MembershipFact> = {}
): MembershipFact => ({
  departmentId,
  function: "other",
  leader: false,
  teamId: TeamId.make(1),
  ...overrides,
});

const person = (
  memberships: readonly MembershipFact[],
  options: { readonly admin?: boolean; readonly personId?: number } = {}
) =>
  principalOf(
    memberships,
    PersonId.make(options.personId ?? 7),
    options.admin === true
  );

const authorize = authorizeWith<string>(Sample.table);

const names = [...Arr.map(Sample.commands, (rpc) => rpc._tag), "viewNotes"];

describe("kernel: authorize reads the grant table and nothing else", () => {
  it.effect(
    "deny by default: a name that no row carries is refused for every principal",
    () =>
      Effect.gen(function* denyByDefault() {
        const result = yield* Arbitrary.checkEffect(
          cases,
          ({ principal, resource }) =>
            !authorize(principal, "nothing", resource),
          { runs: 300 }
        );

        passes(result);
      })
  );

  it.effect(
    "every command and read answers as the oracle's second reading of the table says",
    () =>
      Effect.gen(function* agrees() {
        for (const name of names) {
          passes(yield* agreement(Sample.table, authorize, name));
        }
      })
  );

  it.effect(
    "negative control: the table without any one of its rows no longer agrees with the oracle",
    () =>
      Effect.gen(function* rowRemoved() {
        for (const index of Arr.range(0, Sample.table.length - 1)) {
          const candidate = authorizeWith<string>(without(Sample.table, index));

          const results = yield* Effect.forEach(names, (name) =>
            agreement(Sample.table, candidate, name)
          );

          assert.isTrue(
            Arr.some(results, Predicate.isTagged("Falsified")),
            `removing row ${index} (${Arr.join(Sample.table[index]?.commands ?? [], ", ")}) goes unnoticed`
          );
        }
      })
  );

  it.effect(
    "grants only add up: a row added never refuses a principal that was allowed",
    () =>
      Effect.gen(function* union() {
        const extra = Grant.make([Subject.anyone], ["viewNotes"], "all");
        const widened = authorizeWith<string>([...Sample.table, extra]);

        const result = yield* Arbitrary.checkEffect(
          cases,
          ({ principal, resource }) =>
            Arr.every(
              names,
              (name) =>
                !authorize(principal, name, resource) ||
                widened(principal, name, resource)
            ),
          { runs: 300 }
        );

        passes(result);
      })
  );

  it.effect(
    "authorize never reads a resource beyond the department and the person",
    () =>
      Effect.gen(function* resourcesOnly() {
        const result = yield* Arbitrary.checkEffect(
          Arbitrary.all({ principal: principals, resource: resources }),
          ({ principal, resource }) =>
            Arr.every(
              names,
              (name) =>
                authorize(principal, name, resource) ===
                oracle(Sample.table, principal, name, resource)
            ),
          { runs: 300 }
        );

        passes(result);
      })
  );
});

describe("kernel: scopes", () => {
  it("a department scope needs the department of the resource, and a leader of another department is refused", () => {
    const leader = person([fact(ONE, { leader: true })]);

    assert.isTrue(authorize(leader, "createArticle", { departmentId: ONE }));
    assert.isFalse(authorize(leader, "createArticle", { departmentId: TWO }));
    assert.isFalse(authorize(leader, "createArticle", {}));
  });

  it("a department scope never holds for a member who does not lead, nor for a board member's other department", () => {
    const member = person([fact(ONE)]);
    const board = person([fact(ONE, { function: "board" })]);

    assert.isFalse(authorize(member, "createArticle", { departmentId: ONE }));
    assert.isTrue(authorize(board, "createArticle", { departmentId: ONE }));
    assert.isFalse(authorize(board, "createArticle", { departmentId: TWO }));
  });

  it("an own scope needs the person the resource belongs to", () => {
    const mine = person([], { personId: 7 });

    assert.isTrue(
      authorize(mine, "publishArticle", { personId: PersonId.make(7) })
    );
    assert.isFalse(
      authorize(mine, "publishArticle", { personId: PersonId.make(8) })
    );
    assert.isFalse(authorize(mine, "publishArticle", {}));
  });

  it("scope all holds for the one department-bound set that a row names, wherever the actor belongs", () => {
    const anyDepartment = authorizeWith([
      Grant.make([Subject.member], ["viewNotes"], "all"),
    ]);

    assert.isTrue(anyDepartment(person([fact(TWO)]), "viewNotes"));
    assert.isFalse(anyDepartment(person([]), "viewNotes"));
    assert.isFalse(anyDepartment(anonymous, "viewNotes"));
  });

  it("Anyone holds for every principal, an anonymous one included", () => {
    const open = authorizeWith([
      Grant.make([Subject.anyone], ["viewNotes"], "all"),
    ]);

    assert.isTrue(open(anonymous, "viewNotes"));
    assert.isTrue(open(systemPrincipal("semesters"), "viewNotes"));
    assert.isTrue(open(person([]), "viewNotes"));
  });
});

describe("kernel: admins and system principals (R1)", () => {
  const admin = person([], { admin: true });

  it("the admin row holds every command that a person may run, in every department, and nothing else needs a membership", () => {
    for (const name of ["createArticle", "publishArticle", "viewNotes"]) {
      assert.isTrue(authorize(admin, name, { departmentId: TWO }), name);
      assert.isTrue(authorize(admin, name), name);
    }
  });

  it("an admin does not hold a job's command, and the job holds only its own", () => {
    assert.isFalse(authorize(admin, "sweepArticle"));
    assert.isTrue(authorize(systemPrincipal("semesters"), "sweepArticle"));
    assert.isFalse(authorize(systemPrincipal("endingSoon"), "sweepArticle"));
    assert.isFalse(
      authorize(systemPrincipal("semesters"), "createArticle", {
        departmentId: ONE,
      })
    );
    assert.isFalse(authorize(anonymous, "sweepArticle"));
  });

  it("a person whose admin place is absent holds nothing by it", () => {
    const former = person([]);

    assert.isFalse(authorize(former, "createArticle", { departmentId: ONE }));
  });
});
