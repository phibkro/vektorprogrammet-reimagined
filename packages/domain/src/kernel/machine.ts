/**
 * State machines as transition tables (ADR 0007). The states are a `Schema.TaggedUnion`; each transition names
 * the command that applies it, the states it starts from and the state it ends in, and may carry a guard. The one
 * table drives the runtime check (`can`), the controls the UI shows, the generated diagram and the property tests.
 *
 * A state is either stored (applied as `UPDATE … SET state = to WHERE id = $1 AND state = from`, ADR 0007) or
 * calculated from other facts, such as a membership's term and the current semester. The table does not care: it
 * answers which command may start from which state, and the caller reads the state its own way.
 *
 * `make` takes the domain's `RpcGroup`, so a transition that names a command outside it is a compile error, as is
 * a transition to a state outside the union.
 */
import { Array as Arr, Option, Record as Rec } from "effect";
import type { Schema } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";

/** The pseudo-state before a row exists (`from`) and after it is gone (`to`), as in a Mermaid state diagram. */
export const Boundary = "[*]";

export type Boundary = typeof Boundary;

export interface Transition<
  State extends string,
  Command extends string,
  Context,
> {
  readonly command: Command;
  /** `Boundary` means that the command creates the row. */
  readonly from: readonly (State | Boundary)[];
  /** `Boundary` means that the command removes the row. */
  readonly to: State | Boundary;
  /** Shown on the diagram beside the command: what chooses this transition. */
  readonly when?: string;
  /** A pure check over what the caller supplies; the transition applies only when it holds. */
  readonly guard?: (context: Context) => boolean;
}

/** A change of state that no command makes: time passes (a membership's start semester arrives, its end has passed). */
export interface Calculated<State extends string> {
  readonly from: State | Boundary;
  readonly to: State | Boundary;
  readonly when: string;
}

export interface Table<
  State extends string,
  Command extends string,
  Context = void,
> {
  readonly name: string;
  readonly states: readonly State[];
  readonly transitions: readonly Transition<State, Command, Context>[];
  readonly calculated: readonly Calculated<State>[];
}

/**
 * What the doc generator and the completeness test read of a machine, whatever the context of its guards. Every
 * `Table` is one.
 */
export interface Description {
  readonly name: string;
  readonly states: readonly string[];
  readonly transitions: readonly {
    readonly command: string;
    readonly from: readonly string[];
    readonly to: string;
    readonly when?: string;
  }[];
  readonly calculated: readonly {
    readonly from: string;
    readonly to: string;
    readonly when: string;
  }[];
}

/** A state union as `Schema.TaggedUnion` builds it: its `cases` are keyed by tag. */
interface StateUnion {
  readonly cases: Readonly<Record<string, Schema.Top>>;
}

type TagOf<States extends StateUnion> = keyof States["cases"] & string;

const isTagOf =
  <States extends StateUnion>(states: States) =>
  (key: string): key is TagOf<States> =>
    Rec.has(states.cases, key);

/**
 * Declares a machine. `commands` is the domain's `RpcGroup`: the only source of command names a transition
 * may use.
 */
export const make = <
  const Rpcs extends Rpc.Any,
  const States extends StateUnion,
  Context = void,
>(definition: {
  readonly name: string;
  readonly commands: RpcGroup.RpcGroup<Rpcs>;
  readonly states: States;
  readonly transitions: readonly Transition<
    TagOf<States>,
    Rpcs["_tag"],
    Context
  >[];
  readonly calculated?: readonly Calculated<TagOf<States>>[];
}): Table<TagOf<States>, Rpcs["_tag"], Context> => ({
  calculated: definition.calculated ?? [],
  name: definition.name,
  states: Arr.filter(
    Rec.keys(definition.states.cases),
    isTagOf(definition.states)
  ),
  transitions: definition.transitions,
});

/** The transitions of `command` that start from `state` and whose guard holds for `context`. */
export const available = <
  State extends string,
  Command extends string,
  Context,
>(
  table: Table<State, Command, Context>,
  command: Command,
  state: State | Boundary,
  context: Context
): readonly Transition<State, Command, Context>[] =>
  Arr.filter(
    table.transitions,
    (transition) =>
      transition.command === command &&
      Arr.contains(transition.from, state) &&
      (transition.guard === undefined || transition.guard(context))
  );

/** Whether `command` may be applied in `state`. Pure. */
export const can = <State extends string, Command extends string, Context>(
  table: Table<State, Command, Context>,
  command: Command,
  state: State | Boundary,
  context: Context
): boolean =>
  Arr.isReadonlyArrayNonEmpty(available(table, command, state, context));

/** The state `command` leaves the resource in, when it may be applied in `state`. */
export const next = <State extends string, Command extends string, Context>(
  table: Table<State, Command, Context>,
  command: Command,
  state: State | Boundary,
  context: Context
): Option.Option<State | Boundary> =>
  Option.map(
    Arr.head(available(table, command, state, context)),
    (transition) => transition.to
  );
