/**
 * Spec 0007d, the check: the kernel's own `authorize` and machine tables, asked every row of effx's vectors, answer as
 * the vectors say. The vectors are made by effx from the description that the kernel exports; nothing here reads that
 * description to decide an answer. A world of the vectors (atoms for people, departments, teams and semesters) is
 * turned into the kernel's own values, the kernel is asked, and the two answers are compared row by row.
 */
import {
  DepartmentId,
  Machine,
  PersonId,
  Principal,
  Semester,
  SystemJob,
  TeamFunction,
  TeamId,
  anonymous,
  semesterOfOrdinal,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import type {
  Authorize,
  MembershipFact,
  Resource,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Option, Schema } from "effect";

import type { VectorsFile, WorldFile } from "./vectors.ts";

/** Where the semesters of an order begin: rank 0 is Vår 2026, and each next atom is the next semester. */
const FIRST_ORDINAL = 4052;

type Phase = "afterTick" | "atNow";

/** An answer of the kernel that the vectors answer differently, by the row that asked. */
type Disagreement =
  | {
      readonly effx: boolean;
      readonly instance: number;
      readonly kernel: boolean;
      readonly kind: "authorize";
      readonly permission: string;
      readonly principal: string;
      readonly target: string;
    }
  | {
      readonly context: string;
      readonly effx: boolean;
      readonly instance: number;
      readonly kernel: boolean;
      readonly kind: "command" | "transition";
      readonly machine: string;
      readonly phase: Phase;
      readonly state: string;
      readonly transition: string;
    }
  | {
      readonly instance: number;
      readonly kind: "unreadable";
      readonly what: string;
    };

/** The rows that were compared, by kind, and every one where the two answers differ. */
export interface Report {
  readonly authorization: number;
  readonly commands: number;
  readonly disagreements: readonly Disagreement[];
  readonly transitions: number;
}

const total = (reports: readonly Report[]): Report => ({
  authorization: Arr.reduce(
    reports,
    0,
    (sum, { authorization }) => sum + authorization
  ),
  commands: Arr.reduce(reports, 0, (sum, { commands }) => sum + commands),
  disagreements: Arr.flatMap(reports, ({ disagreements }) => disagreements),
  transitions: Arr.reduce(
    reports,
    0,
    (sum, { transitions }) => sum + transitions
  ),
});

/** `Person$0` is person 1: the number of an atom, plus one so that it is a valid id. */
const idOf = (atom: string): Option.Option<number> =>
  Option.fromNullishOr(/\$(?<digits>\d+)$/u.exec(atom)?.groups?.digits).pipe(
    Option.map((digits) => Number(digits) + 1)
  );

const decodeJob = Schema.decodeUnknownOption(SystemJob);

const decodeFunction = Schema.decodeUnknownOption(TeamFunction);

/** The facts of the memberships of one person that are active in a world, as the kernel's principal carries them. */
const factsOf = (
  world: WorldFile,
  person: string
): Option.Option<readonly MembershipFact[]> =>
  Option.all(
    Arr.flatMap(world.memberships, (membership) => {
      if (membership.person !== person || !membership.active) {
        return [];
      }

      const team = Arr.findFirst(
        world.teams,
        ({ id }) => id === membership.team
      );

      return [
        Option.all({
          departmentId: Option.flatMap(team, ({ department }) =>
            idOf(department)
          ).pipe(Option.map((id) => DepartmentId.make(id))),
          function: Option.flatMap(team, ({ function: name }) =>
            decodeFunction(name)
          ),
          leader: Option.some(membership.position === "leader"),
          teamId: idOf(membership.team).pipe(
            Option.map((id) => TeamId.make(id))
          ),
        }),
      ];
    })
  );

const principalOf = (
  world: WorldFile,
  principal: WorldFile["principals"][number]
): Option.Option<Principal> => {
  if (principal.kind === "Anonymous") {
    return Option.some(anonymous);
  }

  if (principal.kind === "System") {
    return Option.flatMap(Option.fromNullishOr(principal.job), decodeJob).pipe(
      Option.map(systemPrincipal)
    );
  }

  return Option.all({
    id: idOf(principal.id),
    memberships: factsOf(world, principal.id),
  }).pipe(
    Option.map(({ id, memberships }) =>
      principal.admin
        ? Principal.cases.Person.make({
            adminUntil: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
            memberships,
            personId: PersonId.make(id),
          })
        : Principal.cases.Person.make({
            memberships,
            personId: PersonId.make(id),
          })
    )
  );
};

const resourceOf = (target: WorldFile["targets"][number]): Resource => {
  const resource: { -readonly [Key in keyof Resource]: Resource[Key] } = {};

  const department = Option.flatMap(
    Option.fromNullishOr(target.department),
    idOf
  );

  const owner = Option.flatMap(Option.fromNullishOr(target.owner), idOf);

  if (Option.isSome(department)) {
    resource.departmentId = DepartmentId.make(department.value);
  }

  if (Option.isSome(owner)) {
    resource.personId = PersonId.make(owner.value);
  }

  return resource;
};

const authorizationRows = (
  world: WorldFile,
  instance: number,
  vectors: VectorsFile,
  authorize: Authorize<string>
): Report => {
  const allowed = new Set(
    Arr.map(
      world.allows,
      ({ permission, principal, target }) =>
        `${principal}|${permission}|${target}`
    )
  );

  const people = Arr.map(world.principals, (principal) => ({
    kernel: principalOf(world, principal),
    principal,
  }));

  const rows = Arr.flatMap(people, ({ kernel, principal }) =>
    Option.match(kernel, {
      onNone: () => [],
      onSome: (kernelPrincipal) =>
        Arr.flatMap(vectors.permissions, ({ name }) =>
          Arr.map(world.targets, (target) => ({
            effx: allowed.has(`${principal.id}|${name}|${target.id}`),
            kernel: authorize(kernelPrincipal, name, resourceOf(target)),
            permission: name,
            principal: principal.id,
            target: target.id,
          }))
        ),
    })
  );

  return {
    authorization: rows.length,
    commands: 0,
    disagreements: [
      ...Arr.flatMap(people, ({ kernel, principal }) =>
        Option.isNone(kernel)
          ? [{ instance, kind: "unreadable" as const, what: principal.id }]
          : []
      ),
      ...Arr.flatMap(rows, (row) =>
        row.kernel === row.effx
          ? []
          : [{ ...row, instance, kind: "authorize" as const }]
      ),
    ],
    transitions: 0,
  };
};

// ---------------------------------------------------------------- machines

/** A semester of an order, by the place of its atom in the order that the world gives. */
const semesterOf = (world: WorldFile, order: string, atom: string) =>
  Arr.findFirst(world.orders, ({ name }) => name === order).pipe(
    Option.map(({ before }) =>
      semesterOfOrdinal(
        FIRST_ORDINAL + Arr.filter(before, ([, later]) => later === atom).length
      )
    )
  );

/** Semesters under their paths: a context as the guards read it. */
interface Nested {
  readonly [key: string]: Nested | Semester;
}

const isSemester = Schema.is(Semester);

const noContext: Nested = {};

/** `["term", "start"]` and a semester become `{ term: { start: semester } }`, merged into what is there. */
const assoc = (
  target: Nested,
  path: readonly string[],
  semester: Semester
): Nested => {
  const [head, ...rest] = path;

  if (head === undefined) {
    return target;
  }

  const inner = target[head];

  return {
    ...target,
    [head]:
      rest.length === 0
        ? semester
        : assoc(
            inner === undefined || isSemester(inner) ? noContext : inner,
            rest,
            semester
          ),
  };
};

/** Whether a world has the phase: `afterTick` is there only when its clock has a successor. */
const hasPhase = (world: WorldFile, phase: Phase): boolean =>
  phase === "atNow" || (world.clock !== null && world.clock.afterTick !== null);

/** The atom that a field has in a phase: after a tick the clock is its successor, and nothing else moves. */
const atomOf = (
  world: WorldFile,
  field: WorldFile["contexts"][number]["values"][number],
  phase: Phase
): string =>
  field.kind === "clock" && phase === "afterTick"
    ? (world.clock?.afterTick ?? field.value)
    : field.value;

/** The values of a context as the kernel's guards read them. */
const contextOf = (
  world: WorldFile,
  context: WorldFile["contexts"][number],
  phase: Phase
): Option.Option<Nested> =>
  Option.all(
    Arr.map(context.values, (field) =>
      semesterOf(world, field.order, atomOf(world, field, phase)).pipe(
        Option.map((semester) => ({ path: field.path, semester }))
      )
    )
  ).pipe(
    Option.map((values) =>
      Arr.reduce(values, noContext, (raw, { path, semester }) =>
        assoc(raw, path, semester)
      )
    )
  );

/** A machine of the kernel, with the schema of the context that its guards read, ready to be asked. */
export interface MachineUnderTest {
  readonly name: string;
  readonly rows: (
    world: WorldFile,
    instance: number,
    machineIndex: number
  ) => Report;
}

export const machineUnderTest = <
  State extends string,
  Command extends string,
  Context,
>(under: {
  readonly context: Schema.Codec<Context>;
  readonly table: Machine.Table<State, Command, Context>;
}): MachineUnderTest => {
  const { table } = under;
  const decode = Schema.decodeUnknownOption(under.context);

  const states: readonly (State | Machine.Boundary)[] = [
    Machine.Boundary,
    ...table.states,
  ];

  const commands = Arr.dedupe(
    Arr.map(table.transitions, ({ command }) => command)
  );

  /** Every row of one context in one phase: each state against each transition, the changes of time too, and each command. */
  const ask = (
    world: WorldFile,
    instance: number,
    machineIndex: number,
    context: WorldFile["contexts"][number],
    phase: Phase
  ): Report => {
    const moment = Option.flatMap(contextOf(world, context, phase), decode);

    if (Option.isNone(moment)) {
      return {
        authorization: 0,
        commands: 0,
        disagreements: [{ instance, kind: "unreadable", what: context.id }],
        transitions: 0,
      };
    }

    const enabled = new Set(
      Arr.map(
        world.enabled[phase],
        (row) => `${row.machine}|${row.state}|${row.context}|${row.transition}`
      )
    );

    // effx names a transition by its machine and its place in the list: the commands' first, then the changes of time.
    const byTransition = Arr.flatMap(states, (state) => [
      ...Arr.map(table.transitions, (transition, index) => {
        const name = `Transition${machineIndex}_${index}`;

        return {
          command: transition.command,
          effx: enabled.has(`${table.name}|${state}|${context.id}|${name}`),
          kernel:
            Arr.contains(transition.from, state) &&
            (transition.accepts?.(moment.value) ?? true),
          state,
          transition: name,
        };
      }),
      ...Arr.map(table.calculated, (change, index) => {
        const name = `Transition${machineIndex}_${table.transitions.length + index}`;

        return {
          command: undefined,
          effx: enabled.has(`${table.name}|${state}|${context.id}|${name}`),
          kernel: change.from === state && change.accepts(moment.value),
          state,
          transition: name,
        };
      }),
    ]);

    const byCommand = Arr.flatMap(states, (state) =>
      Arr.map(commands, (command) => ({
        effx: Arr.some(
          byTransition,
          (row) => row.state === state && row.command === command && row.effx
        ),
        kernel: Machine.can(table, command, state, moment.value),
        state,
        transition: command,
      }))
    );

    const disagreement =
      (kind: "command" | "transition") =>
      (row: {
        readonly effx: boolean;
        readonly kernel: boolean;
        readonly state: string;
        readonly transition: string;
      }): Disagreement[] =>
        row.effx === row.kernel
          ? []
          : [
              {
                context: context.id,
                effx: row.effx,
                instance,
                kernel: row.kernel,
                kind,
                machine: table.name,
                phase,
                state: row.state,
                transition: row.transition,
              },
            ];

    return {
      authorization: 0,
      commands: byCommand.length,
      disagreements: [
        ...Arr.flatMap(byTransition, disagreement("transition")),
        ...Arr.flatMap(byCommand, disagreement("command")),
      ],
      transitions: byTransition.length,
    };
  };

  return {
    name: table.name,
    rows: (world, instance, machineIndex) =>
      total(
        Arr.flatMap(
          Arr.filter(world.contexts, ({ machine }) => machine === table.name),
          (context: WorldFile["contexts"][number]) =>
            Arr.flatMap(["atNow", "afterTick"] as const, (phase) =>
              hasPhase(world, phase)
                ? [ask(world, instance, machineIndex, context, phase)]
                : []
            )
        )
      ),
  };
};

/**
 * Every row of a vectors file, asked of the kernel. `machineOrder` is the order of the machines in the description that
 * effx was given: it names the transitions of a machine (`Transition0_3`).
 */
export const compare = (
  vectors: VectorsFile,
  kernel: {
    readonly authorize: Authorize<string>;
    readonly machineOrder: readonly string[];
    readonly machines: readonly MachineUnderTest[];
  }
): Report =>
  total(
    Arr.flatMap(vectors.instances, (world, instance) => [
      authorizationRows(world, instance, vectors, kernel.authorize),
      ...Arr.map(kernel.machines, (machine) =>
        machine.rows(
          world,
          instance,
          Math.max(0, kernel.machineOrder.indexOf(machine.name))
        )
      ),
    ])
  );
