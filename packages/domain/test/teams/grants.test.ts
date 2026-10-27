/**
 * Falsifiers 1 and 2 of spec 0006 over the real declarations. The kernel's own laws, over a sample domain, are in
 * `test/kernel/authorize.test.ts`; here the subject is `GrantTable`, the table that the control panel, every
 * handler and the generated `docs/system/teams.md` read.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  Effect,
  Order,
  Predicate,
  Record as Rec,
} from "effect";

import {
  Declarations,
  Domain,
  GrantTable,
  Subject,
  authorize,
  authorizeWith,
  systemPrincipal,
} from "../../src/index.ts";
import type { Command, Principal, Resource } from "../../src/index.ts";
import type { Declaration } from "../../src/kernel/domain.ts";
import { agreement, cases, passes, without } from "../support/grantLaws.ts";
import { TRONDHEIM, admin, teamLeaderTrondheim } from "../support/inMemory.ts";

/** Every name that a grant row may carry: the commands and the reads of every domain. */
const NAMES: readonly string[] = Arr.flatMap(Declarations, (domain) => [
  ...Arr.map(domain.commands, (rpc) => rpc._tag),
  ...Rec.keys(domain.reads),
]);

const isCommand = (name: string): name is Command => Arr.contains(NAMES, name);

/** The `authorize` the app uses, asked about a name that may or may not be one of the table's. */
const appAuthorize = (
  principal: Principal,
  name: string,
  resource: Resource
): boolean => isCommand(name) && authorize(principal, name, resource);

/** The table without `command` in any row; a row left with no command is dropped. */
const withoutCommand = (
  table: Declaration["table"],
  command: string
): Declaration["table"] =>
  Arr.flatMap(table, (row) => {
    const rest = Arr.filter(row.commands, (name) => name !== command);

    return Arr.isReadonlyArrayNonEmpty(rest)
      ? [{ ...row, commands: rest }]
      : [];
  });

describe("falsifier 1: authorize equals the grant table", () => {
  it.effect(
    "falsifier 1: for every command and read, authorize answers as the rows of GrantTable say, for generated persons, jobs and anonymous principals",
    () =>
      Effect.gen(function* agrees() {
        for (const name of NAMES) {
          passes(yield* agreement(GrantTable, appAuthorize, name));
        }
      })
  );

  it.effect(
    "falsifier 1, negative control: the table without any one row no longer agrees (so the property can fail)",
    () =>
      Effect.gen(function* rowRemoved() {
        for (const index of Arr.range(0, GrantTable.length - 1)) {
          const candidate = authorizeWith<string>(without(GrantTable, index));

          const results = yield* Effect.forEach(NAMES, (name) =>
            agreement(GrantTable, candidate, name)
          );

          assert.isTrue(
            Arr.some(results, Predicate.isTagged("Falsified")),
            `removing row ${index} (${Arr.join(GrantTable[index]?.commands ?? [], ", ")}) goes unnoticed`
          );
        }
      })
  );

  it.effect(
    "deny by default: a name that no row carries is refused for everyone",
    () =>
      Effect.gen(function* denied() {
        const refused = yield* Arbitrary.checkEffect(
          cases,
          ({ principal, resource }) =>
            !appAuthorize(principal, "nothing", resource),
          { runs: 300 }
        );

        passes(refused);
      })
  );

  it("the table has exactly one Admin row, and it names every command a person may run", () => {
    const adminRows = Arr.filter(GrantTable, (row) =>
      Arr.some(row.subjects, Predicate.isTagged("Admin"))
    );

    assert.strictEqual(adminRows.length, 1);
    assert.strictEqual(adminRows[0]?.scope, "all");
    assert.deepStrictEqual(
      Arr.sort([...(adminRows[0]?.commands ?? [])], Order.String),
      Arr.sort(
        Arr.flatMap(
          Declarations,
          (domain): readonly string[] => domain.personal
        ),
        Order.String
      )
    );
  });

  it("R1: each job holds exactly its own command; no person holds a job's command, an admin included", () => {
    const jobs = [
      ["semesters", "ensureSemesters"],
      ["outboxSweep", "sweepOutbox"],
      ["endingSoon", "sendEndingSoon"],
    ] as const;

    for (const [job, command] of jobs) {
      const principal = systemPrincipal(job);
      assert.isTrue(authorize(principal, command), `${job} holds ${command}`);
      assert.isFalse(authorize(admin, command), `an admin holds ${command}`);
      assert.isFalse(
        authorize(teamLeaderTrondheim, command, { departmentId: TRONDHEIM }),
        `a leader holds ${command}`
      );

      for (const [other, ownCommand] of jobs) {
        assert.strictEqual(
          authorize(principal, ownCommand),
          other === job,
          `${job} and ${ownCommand}`
        );
      }
    }
  });
});

describe("falsifier 2: declarations are complete", () => {
  it("every domain is complete: each command and read has a grant, each grant names a known command, each transition names a command of its group, and the jobs hold their commands", () => {
    for (const domain of Declarations) {
      assert.deepStrictEqual(Domain.problems(domain), [], domain.name);
    }
  });

  it("negative control: a command without any grant is reported, for every command of every domain", () => {
    for (const domain of Declarations) {
      for (const name of [
        ...Arr.map(domain.commands, (rpc) => rpc._tag),
        ...Rec.keys(domain.reads),
      ]) {
        const stripped: Declaration = {
          ...domain,
          table: withoutCommand(domain.table, name),
        };

        assert.include(
          Domain.problems(stripped),
          `${name} has no grant`,
          `${domain.name}: ${name}`
        );
      }
    }
  });

  it("negative control: a grant that names an unknown command is reported", () => {
    for (const domain of Declarations) {
      const widened: Declaration = {
        ...domain,
        table: [
          ...domain.table,
          { commands: ["ghost"], scope: "all", subjects: [Subject.anyone] },
        ],
      };

      assert.include(
        Domain.problems(widened),
        `a grant names ghost, which is neither a command nor a read of ${domain.name}`
      );
    }
  });

  it("negative control: a transition that names a command outside its group is reported", () => {
    for (const domain of Declarations) {
      for (const machine of domain.machines) {
        const stray: Declaration = {
          ...domain,
          machines: [
            {
              ...machine,
              transitions: [
                ...machine.transitions,
                { command: "ghost", from: [], to: "ghost" },
              ],
            },
          ],
        };

        assert.include(
          Domain.problems(stray),
          `${machine.name} has a transition for ghost, which is not a command of ${domain.name}`
        );
      }
    }
  });
});
