/**
 * The kernel's declaration laws (spec 0006, falsifier 2), the handler that asks the grant table before it runs
 * (ADR 0006), the in-process client, and the transition tables (ADR 0007), over the sample domain.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Exit, Option, Ref, Schema } from "effect";
import { Rpc } from "effect/rpc";
import { expectTypeOf } from "vite-plus/test";

import {
  Commands,
  CurrentPrincipal,
  DepartmentId,
  Domain,
  Forbidden,
  Grant,
  Machine,
  PersonId,
  Principal,
  Subject,
  TeamId,
  anonymous,
  systemPrincipal,
} from "../../src/index.ts";
import type { MembershipFact } from "../../src/index.ts";
import type { Declaration } from "../../src/kernel/domain.ts";
import type { NoteStates } from "./sample.ts";
import {
  NoteMachine,
  Notes,
  Sample,
  create,
  publish,
  sweep,
} from "./sample.ts";

const ONE = DepartmentId.make(1);

const TWO = DepartmentId.make(2);

const leading = (departmentId: DepartmentId, teamId = 1): MembershipFact => ({
  departmentId,
  function: "other",
  leader: true,
  teamId: TeamId.make(teamId),
});

const personOf = (memberships: readonly MembershipFact[]) =>
  Principal.cases.Person.make({ memberships, personId: PersonId.make(3) });

const asPrincipal = (principal: Principal) =>
  Effect.provideService(CurrentPrincipal, principal);

const withoutRowsNaming = (command: string): Declaration["table"] =>
  Arr.filter(Sample.table, (row) => !Arr.contains(row.commands, command));

describe("falsifier 2: a declaration is complete", () => {
  it("the sample is complete: every command and read has a grant, every grant names a known command", () => {
    assert.deepStrictEqual(Domain.problems(Sample), []);
  });

  it("a command without a grant is reported", () => {
    const stripped: Declaration = {
      ...Sample,
      table: withoutRowsNaming("create"),
    };

    assert.include(Domain.problems(stripped), "create has no grant");
  });

  it("a grant that names an unknown command is reported", () => {
    const widened: Declaration = {
      ...Sample,
      table: [
        ...Sample.table,
        Grant.make([Subject.anyone], ["destroy"], "all"),
      ],
    };

    assert.deepStrictEqual(
      Arr.filter(Domain.problems(widened), (line) => line.includes("destroy")),
      ["a grant names destroy, which is neither a command nor a read of notes"]
    );
  });

  it("a transition that names a command outside its group is reported", () => {
    const stray: Declaration = {
      ...Sample,
      machines: [
        {
          ...NoteMachine,
          transitions: [
            ...NoteMachine.transitions,
            { command: "archive", from: ["Published"], to: "Draft" },
          ],
        },
      ],
    };

    assert.include(
      Domain.problems(stray),
      "Note has a transition for archive, which is not a command of notes"
    );
  });

  it("a transition to a state outside the machine is reported", () => {
    const stray: Declaration = {
      ...Sample,
      machines: [
        {
          ...NoteMachine,
          transitions: [{ command: "publish", from: ["Draft"], to: "Printed" }],
        },
      ],
    };

    assert.include(
      Domain.problems(stray),
      "Note has a transition that names the undeclared state Printed"
    );
  });

  it("a command that applies a machine with no transition for it is reported", () => {
    const orphaned: Declaration = {
      ...Sample,
      machines: [{ ...NoteMachine, transitions: [] }],
    };

    assert.include(
      Domain.problems(orphaned),
      "publish applies Note, which has no transition for it"
    );
  });

  it("R1: a job's command that an admin holds, or that another job holds, is reported; so is a job without its grant", () => {
    const heldByAdmin: Declaration = {
      ...Sample,
      table: [...Sample.table, Grant.make([Subject.admin], ["sweep"], "all")],
    };

    const heldByAnotherJob: Declaration = {
      ...Sample,
      table: [
        ...withoutRowsNaming("sweep"),
        Grant.make([Subject.system("endingSoon")], ["sweep"], "all"),
      ],
    };

    assert.include(
      Domain.problems(heldByAdmin),
      "sweep is the semesters job's command, but Admin is granted it"
    );
    assert.include(
      Domain.problems({ ...Sample, table: withoutRowsNaming("sweep") }),
      "sweep has no grant"
    );
    assert.include(
      Domain.problems(heldByAnotherJob),
      "sweep is the semesters job's command, but System(endingSoon) is granted it"
    );
    assert.include(
      Domain.problems(heldByAnotherJob),
      "sweep is the semesters job's command, and System(semesters) holds no grant for it"
    );
  });

  it("R1: a System principal is granted only a job's commands", () => {
    const wrong: Declaration = {
      ...Sample,
      table: [
        ...Sample.table,
        Grant.make([Subject.system("semesters")], ["create"], "all"),
      ],
    };

    assert.include(
      Domain.problems(wrong),
      "create is not a job's command, but System(semesters) is granted it"
    );
  });

  it("an admin that does not hold a person's command is reported: the admin row is part of the table", () => {
    const noAdminRow: Declaration = { ...Sample, table: Sample.declared };

    assert.include(
      Domain.problems(noAdminRow),
      "an admin does not hold create"
    );
  });

  it("a command without its Info annotation is reported", () => {
    const bare = Rpc.make("bare", { success: Schema.Void });

    const unannotated: Declaration = {
      ...Sample,
      commands: [...Sample.commands, bare],
    };

    assert.include(
      Domain.problems(unannotated),
      "bare carries no Info annotation"
    );
  });
});

describe("ADR 0006: a handler asks the grant table before it runs", () => {
  const ran = Ref.makeUnsafe(0);

  const createHandler = Sample.handle(create, {
    resource: ({ departmentId }) => Effect.succeed({ departmentId }),
    run: () => Ref.update(ran, (count) => count + 1),
  });

  it.effect("a leader of the department runs the command", () =>
    Effect.gen(function* allowed() {
      yield* Ref.set(ran, 0);
      yield* createHandler({ departmentId: ONE }).pipe(
        asPrincipal(personOf([leading(ONE)]))
      );

      assert.strictEqual(yield* Ref.get(ran), 1);
    })
  );

  it.effect(
    "a refused principal gets Forbidden naming the command, and the command does not run",
    () =>
      Effect.gen(function* refused() {
        yield* Ref.set(ran, 0);

        for (const principal of [
          anonymous,
          personOf([leading(TWO)]),
          systemPrincipal("semesters"),
        ]) {
          const error = yield* Effect.flip(
            createHandler({ departmentId: ONE }).pipe(asPrincipal(principal))
          );

          assert.instanceOf(error, Forbidden);
        }

        assert.strictEqual(yield* Ref.get(ran), 0);
      })
  );

  it.effect(
    "a command about two resources needs the grant for both: a move between departments",
    () =>
      Effect.gen(function* both() {
        const move = Sample.handle(create, {
          resource: () =>
            Effect.succeed([
              { departmentId: ONE },
              { departmentId: TWO },
            ] as const),
          run: () => Effect.void,
        });

        const exits = yield* Effect.forEach(
          [
            personOf([leading(ONE)]),
            personOf([leading(TWO)]),
            personOf([leading(ONE), leading(TWO, 2)]),
          ],
          (principal) =>
            Effect.exit(
              move({ departmentId: ONE }).pipe(asPrincipal(principal))
            )
        );

        assert.deepStrictEqual(Arr.map(exits, Exit.isSuccess), [
          false,
          false,
          true,
        ]);
      })
  );

  it.effect(
    "the in-process client delivers a success unchanged and a typed error as the class the handler failed with",
    () =>
      Effect.gen(function* inProcess() {
        const handlers = Notes.toLayer({
          create: createHandler,
          publish: Sample.handle(publish, {
            resource: ({ departmentId, personId }) =>
              Effect.succeed({ departmentId, personId }),
            run: ({ personId }) => Effect.succeed(`published for ${personId}`),
          }),
          sweep: Sample.handle(sweep, {
            resource: () => Effect.succeed({}),
            run: () => Effect.succeed(1),
          }),
        });

        const client = Commands.inProcess(Notes, handlers);

        const published = yield* client((c) =>
          c.publish({ departmentId: ONE, personId: PersonId.make(3) })
        ).pipe(asPrincipal(personOf([])));

        assert.strictEqual(published, "published for 3");

        const error = yield* Effect.flip(
          client((c) => c.create({ departmentId: ONE })).pipe(
            asPrincipal(anonymous)
          )
        );

        assert.instanceOf(error, Forbidden);
      })
  );

  it.effect(
    "the payload decoder is the schema of the command: a bad department is one ValidationFailed with its path",
    () =>
      Effect.gen(function* decoding() {
        const error = yield* Effect.flip(
          Commands.decodePayload(create)({ departmentId: "x" })
        );

        assert.strictEqual(error._tag, "ValidationFailed");
        assert.deepStrictEqual(
          Arr.map(error.issues, (issue) => issue.path),
          [["departmentId"]]
        );
      })
  );
});

describe("ADR 0007: transition tables", () => {
  const words = { words: 4 };

  it("can: a command starts from the states its transitions name, and only when its guard holds", () => {
    assert.isTrue(Machine.can(NoteMachine, "create", Machine.Boundary, words));
    assert.isTrue(Machine.can(NoteMachine, "publish", "Draft", words));
    assert.isFalse(Machine.can(NoteMachine, "publish", "Published", words));
    assert.isFalse(Machine.can(NoteMachine, "publish", "Draft", { words: 0 }));
    assert.isFalse(Machine.can(NoteMachine, "create", "Draft", words));
  });

  it("next: the state a command leaves the resource in", () => {
    assert.deepStrictEqual(
      Machine.next(NoteMachine, "publish", "Draft", words),
      Option.some("Published")
    );
    assert.isTrue(
      Option.isNone(Machine.next(NoteMachine, "publish", "Published", words))
    );
  });

  it("the machine lists its states from the union, in declaration order", () => {
    assert.deepStrictEqual(NoteMachine.states, ["Draft", "Published"]);
  });

  it("a transition's command is a tag of the group and its states are the union's: anything else does not type-check", () => {
    type Input = Parameters<
      typeof Machine.make<typeof create | typeof publish, typeof NoteStates>
    >[0];

    type Transition = Input["transitions"][number];

    expectTypeOf<Transition["command"]>().toEqualTypeOf<"create" | "publish">();
    expectTypeOf<Transition["to"]>().toEqualTypeOf<
      "Draft" | "Published" | "[*]"
    >();
  });
});
