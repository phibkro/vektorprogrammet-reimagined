/**
 * The part of effx's `ConformanceVectors` (spec 0032, format `effx-alloy-vectors` version 1) that the kernel is checked
 * against. effx's own schema is not a dependency (ADR 0009), so this reads what it needs and nothing more: a vectors
 * file in another format or version, or without a field read here, is a decode failure and not a pass. effx decodes the
 * whole of it when it writes the file.
 */
import { Array as Arr, Schema } from "effect";

const Field = Schema.Struct({
  kind: Schema.Literals(["stored", "parameter", "clock"]),
  order: Schema.String,
  path: Schema.Array(Schema.String),
  value: Schema.String,
});

const Enabled = Schema.Struct({
  context: Schema.String,
  machine: Schema.String,
  state: Schema.String,
  transition: Schema.String,
});

/** One instance of the vectors: a world of people, teams, targets and contexts, and what is allowed and enabled in it. */
const World = Schema.Struct({
  allows: Schema.Array(
    Schema.Struct({
      permission: Schema.String,
      principal: Schema.String,
      target: Schema.String,
    })
  ),
  clock: Schema.NullOr(
    Schema.Struct({
      afterTick: Schema.NullOr(Schema.String),
      now: Schema.String,
      order: Schema.String,
    })
  ),
  contexts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      machine: Schema.String,
      values: Schema.Array(Field),
    })
  ),
  enabled: Schema.Struct({
    afterTick: Schema.Array(Enabled),
    atNow: Schema.Array(Enabled),
  }),
  memberships: Schema.Array(
    Schema.Struct({
      active: Schema.Boolean,
      id: Schema.String,
      person: Schema.String,
      position: Schema.String,
      team: Schema.String,
    })
  ),
  orders: Schema.Array(
    Schema.Struct({
      before: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      name: Schema.String,
    })
  ),
  principals: Schema.Array(
    Schema.Struct({
      admin: Schema.Boolean,
      id: Schema.String,
      job: Schema.optionalKey(Schema.String),
      kind: Schema.Literals(["Anonymous", "Person", "System"]),
    })
  ),
  targets: Schema.Array(
    Schema.Struct({
      department: Schema.optionalKey(Schema.String),
      id: Schema.String,
      owner: Schema.optionalKey(Schema.String),
    })
  ),
  teams: Schema.Array(
    Schema.Struct({
      department: Schema.String,
      function: Schema.String,
      id: Schema.String,
    })
  ),
});

export type WorldFile = typeof World.Type;

export const Vectors = Schema.Struct({
  domain: Schema.String,
  format: Schema.Literal("effx-alloy-vectors"),
  instances: Schema.Array(World),
  nondeterministic: Schema.Array(Schema.String),
  orderedAtoms: Schema.Int,
  permissions: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["Command", "Read"]),
      name: Schema.String,
    })
  ),
  scope: Schema.Int,
  steps: Schema.Int,
  unknownGuards: Schema.Array(Schema.String),
  version: Schema.Literal(1),
});

export type VectorsFile = typeof Vectors.Type;

/** How many states, transitions, calculated transitions and distinct commands a machine of a description has. */
export interface MachineCounts {
  readonly calculated: number;
  readonly commands: number;
  readonly name: string;
  readonly states: number;
  readonly transitions: number;
}

/** The rows of one kind: for each context of each machine and each available phase, every state against `perState`. */
const rowsOf = (
  vectors: VectorsFile,
  machines: readonly MachineCounts[],
  perState: (machine: MachineCounts) => number
) =>
  Arr.reduce(vectors.instances, 0, (sum, instance) => {
    const phases =
      instance.clock === null || instance.clock.afterTick === null ? 1 : 2;

    return (
      sum +
      Arr.reduce(
        machines,
        0,
        (inner, machine) =>
          inner +
          Arr.filter(
            instance.contexts,
            ({ machine: name }) => name === machine.name
          ).length *
            phases *
            (machine.states + 1) *
            perState(machine)
      )
    );
  });

/**
 * The rows that a vectors file asks the kernel about, counted from its structure alone: every principal, permission
 * and target of an instance (`authorization`), and for every context, state (and the boundary) and available phase of
 * each machine, every transition, those of commands and the changes of time alike (`transitions`), and every command
 * (`commands`, the `Machine.can` rows). The conformance run counts what it compares and the two must be the same
 * number, so a truncated file, or a run that skips a loop, cannot pass.
 */
export const countRows = (
  vectors: VectorsFile,
  machines: readonly MachineCounts[]
) => ({
  authorization: Arr.reduce(
    vectors.instances,
    0,
    (sum, instance) =>
      sum +
      instance.principals.length *
        vectors.permissions.length *
        instance.targets.length
  ),
  commands: rowsOf(vectors, machines, ({ commands }) => commands),
  transitions: rowsOf(
    vectors,
    machines,
    ({ calculated, transitions }) => transitions + calculated
  ),
});
