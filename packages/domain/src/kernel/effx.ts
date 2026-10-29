/**
 * The kernel's domains, said to effx (spec 0007d, ADR 0009). `describe` turns one `Declaration` into the
 * `DomainDescription` of effx spec 0032 (§2, R1 and R2) and lists, as typed gaps, everything that the declaration says
 * and effx cannot state, and everything that effx needs and the declaration does not say. It is pure: the description
 * is a function of the declarations, so it cannot disagree with them, and nothing is dropped without a name.
 *
 * The contract is effx's (`DomainDescription` in `@effx/domain-model`). That package is not published and is not a
 * dependency here (ADR 0009), so this module holds the plain form of what the kernel exports; effx decodes it strictly
 * when its conformance vectors are regenerated (`tools/effx-conformance`), and that tool's tests check the kernel
 * against those vectors.
 */
import { Array as Arr, Option, Predicate, Record as Rec, Schema } from "effect";

import { AggregateRoots } from "../shared/aggregate.ts";
import * as Commands from "./commands.ts";
import { namesOf } from "./domain.ts";
import type { Declaration } from "./domain.ts";
import * as Guard from "./guard.ts";
import type { FieldKind } from "./guard.ts";
import type { Description as MachineDescription } from "./machine.ts";
import { SystemJob } from "./principal.ts";
import * as Subject from "./subject.ts";

type Json = Schema.Json;

/** The one ordered type of the kernel's machines: a semester. */
export const SEMESTER_ORDER = "Semester";

// ---------------------------------------------------------------- the form that effx reads

/** A subject set as effx states it: memberships (of a function, a position, in a department), `Self`, `Admin`, a job. */
export const Expression = Schema.TaggedUnion({
  Admin: {},
  Membership: {
    department: Schema.Literals(["any", "target"]),
    function: Schema.optionalKey(Schema.String),
    position: Schema.optionalKey(Schema.String),
    term: Schema.Literals(["active", "any"]),
  },
  Self: {},
  System: { job: Schema.String },
  Union: { sets: Schema.Array(Schema.String) },
});

export type Expression = typeof Expression.Type;

export interface SubjectSet {
  readonly expression: Expression;
  readonly name: string;
}

export interface GrantRow {
  readonly permits: readonly string[];
  readonly scope: Subject.Scope;
  readonly subject: string;
}

/** A guard as effx reads it: the check, and the machine context that it is a check over. */
export interface EffxGuard {
  readonly context: string;
  readonly representation: Json;
}

/**
 * The optional members of the description are `undefined` when they are absent, and a literal that names them keeps the
 * alphabetical order of its keys: `JSON.stringify` leaves out what is `undefined`, so the committed text is the same
 * whether a member is absent or `undefined`, and its keys are in one order.
 */
export interface EffxTransition {
  readonly command: string;
  readonly from: readonly string[];
  readonly guard?: EffxGuard | undefined;
  readonly to: string;
}

export interface EffxMachine {
  readonly calculated: readonly {
    readonly from: string;
    readonly to: string;
    readonly when: EffxGuard;
  }[];
  readonly context: {
    readonly clockPath?: readonly string[] | undefined;
    readonly fields: readonly {
      readonly kind: FieldKind;
      readonly order: string;
      readonly path: readonly string[];
    }[];
    readonly name: string;
  };
  readonly name: string;
  readonly states: readonly string[];
  readonly terminal: readonly string[];
  readonly transitions: readonly EffxTransition[];
}

export interface EffxCommand {
  readonly kind: "Command";
  readonly name: string;
  readonly runBy?: { readonly job: string } | undefined;
}

export interface EffxDescription {
  readonly adminList?:
    | { readonly grant: string; readonly revoke: string }
    | undefined;
  readonly clock?: { readonly order: string } | undefined;
  readonly commands: readonly EffxCommand[];
  readonly grants: readonly GrantRow[];
  readonly machines: readonly EffxMachine[];
  readonly memberships?:
    | {
        readonly grantingStates: readonly string[];
        readonly machine: string;
      }
    | undefined;
  readonly name: string;
  readonly orders: readonly { readonly name: string }[];
  readonly principals: {
    readonly Anonymous: Record<string, never>;
    readonly Person: Record<string, never>;
    readonly System: { readonly jobs: readonly string[] };
  };
  readonly reads: readonly { readonly name: string }[];
  readonly subjectSets: readonly SubjectSet[];
}

// ---------------------------------------------------------------- gaps

const Names = Schema.Array(Schema.String);

/**
 * What crosses between the kernel and effx in one direction only. Each one is a value, listed in the committed
 * register (`packages/domain/conformance/gaps.json`) that a test compares with the export, so a new construct that
 * effx cannot state is a failing diff and a decision.
 */
export const Gap = Schema.TaggedUnion({
  /** The admin list has places that end on a date; effx's expiry is a guard over a clock-bound context. */
  AdminExpiry: { domain: Schema.String },
  /** The domain has some commands of the admin list (resource `AdminGrant`, `create` or `delete`), but not one of each. */
  AdminListUnclear: { domain: Schema.String, grants: Names, revokes: Names },
  /** A machine that effx cannot be given whole, and the reason. */
  MachineDropped: {
    domain: Schema.String,
    machine: Schema.String,
    reason: Schema.String,
  },
  /** A guard reads semesters that the machine does not declare as fields (so effx cannot know their kind). */
  MissingDeclaration: {
    domain: Schema.String,
    machine: Schema.String,
    paths: Schema.Array(Names),
  },
  /** A domain with nothing left to say to effx. */
  NoDescription: { domain: Schema.String, reason: Schema.String },
  /** A kernel declaration that the description has no field for. */
  NoField: { field: Schema.String, values: Names },
  /** Commands that change stored fields of a machine, with no declaration of which: effx keeps the fields fixed. */
  UndeclaredWrites: {
    commands: Names,
    domain: Schema.String,
    machine: Schema.String,
  },
  /** A guard check outside the closed vocabulary that effx knows. `transition` is a command, or `from → to` of a change that time makes. */
  UnexpressibleGuard: {
    domain: Schema.String,
    id: Schema.String,
    machine: Schema.String,
    transition: Schema.String,
  },
  /** A subject set that effx has no expression for, and the commands and reads whose rows it is in (they leave). */
  UnexpressibleSubject: {
    commands: Names,
    domain: Schema.String,
    subject: Schema.String,
  },
});

export type Gap = typeof Gap.Type;

/** Who can remove a kind of gap, or a part of one, and what they change. */
export interface Closure {
  /** The kernel's own declarations, or effx: an issue on `phibkro/effx` or a spec of its own. */
  readonly by: "effx" | "kernel";
  readonly change: string;
}

interface DropReason {
  readonly closure: Closure;
  /** The words that `MachineDropped` says it in; a reason that names the commands that left takes them, joined. */
  readonly say: string | ((commands: string) => string);
}

/**
 * The ways in which a machine cannot be given to effx whole, each with the words that `MachineDropped` says it in and
 * the party that removes it. `MachineDropped` has no closure of its own: it is closed by whoever closes each of its
 * reasons, and they are not all effx's (the kernel closes a semester that its guards read and `fields` does not
 * declare). The words and the party are one record, so a reason without a party does not compile.
 */
const dropReasons = {
  lostCommand: {
    closure: {
      by: "effx",
      change:
        "an `Anonymous` subject and a credential subject, for a command that left with its subject (effx issue 9)",
    },
    say: (commands: string) =>
      `a transition applies ${commands}, which effx cannot be given`,
  },
  undeclaredSemester: {
    closure: {
      by: "kernel",
      change:
        "the machine declares each semester that its guards read, in `fields`",
    },
    say: "a guard reads a semester that the machine does not declare",
  },
  unknownCheck: {
    closure: {
      by: "effx",
      change:
        "guard operands that are ids and flags, with comparisons over them (effx issue 9)",
    },
    say: "a guard uses a check that effx does not know",
  },
} satisfies Readonly<Record<string, DropReason>>;

/**
 * What closes each kind of gap, as the steps of whoever closes it (a kind that two parties close has a step for each).
 * The type is a record over the kinds, so a kind that nobody has said how to close does not compile. This repository
 * never edits effx: a closure by effx is an issue there, and spec 0007d says where each stands.
 */
export const closures: Readonly<Record<Gap["_tag"], readonly Closure[]>> = {
  AdminExpiry: [
    {
      by: "effx",
      change:
        "state that a place ends when a stored field of the place, of an order of its own, is reached by the clock (effx issue 10)",
    },
  ],
  AdminListUnclear: [
    {
      by: "kernel",
      change:
        "the domain declares one command that grants a place and one that revokes it, or neither",
    },
  ],
  MachineDropped: Arr.map(Rec.values(dropReasons), ({ closure }) => closure),
  MissingDeclaration: [
    {
      by: "kernel",
      change:
        "the machine declares each semester that its guards read, in `fields`",
    },
  ],
  NoDescription: [
    {
      by: "effx",
      change:
        "close the gaps that left nothing to say: for `contact`, the `Anyone` subject (effx issue 9)",
    },
  ],
  NoField: [
    {
      by: "effx",
      change:
        "a field of the description for the aggregate roots, with entities and relationships (the entity slice of effx spec 0031)",
    },
  ],
  UndeclaredWrites: [
    {
      by: "kernel",
      change:
        "each command declares the stored fields that it writes (`writes`, effx spec 0032 §2); effx lets its model choose any value of a written field until its slice of detailed command effects",
    },
  ],
  UnexpressibleGuard: [
    {
      by: "effx",
      change:
        "guard operands that are ids and flags, with comparisons over them (effx issue 9)",
    },
  ],
  UnexpressibleSubject: [
    {
      by: "effx",
      change: "an `Anonymous` subject and a credential subject (effx issue 9)",
    },
  ],
};

/** What the kernel declares once for every domain and the description has no field for. */
export const kernelGaps: readonly Gap[] = [
  Gap.cases.NoField.make({ field: "aggregate roots", values: AggregateRoots }),
];

export interface Export {
  /** None when nothing is left to say. */
  readonly description: Option.Option<EffxDescription>;
  readonly gaps: readonly Gap[];
}

// ---------------------------------------------------------------- subject sets and grants

/** The subject set of a subject under a scope, when effx can state it: a departmental subject follows the scope. */
const expressionOf = (
  subject: Subject.Any,
  scope: Subject.Scope
): Option.Option<Expression> => {
  const department = scope === "department" ? "target" : "any";

  return Subject.Any.match(subject, {
    Admin: () => Option.some(Expression.cases.Admin.make({})),
    Anyone: () => Option.none(),
    Fn: ({ function: teamFunction }) =>
      Option.some(
        Expression.cases.Membership.make({
          department,
          function: teamFunction,
          term: "active",
        })
      ),
    Holder: () => Option.none(),
    Leader: () =>
      Option.some(
        Expression.cases.Membership.make({
          department,
          position: "leader",
          term: "active",
        })
      ),
    Member: () =>
      Option.some(
        Expression.cases.Membership.make({ department, term: "active" })
      ),
    Self: () => Option.some(Expression.cases.Self.make({})),
    System: ({ job }) => Option.some(Expression.cases.System.make({ job })),
  });
};

const setName = (subject: Subject.Any, scope: Subject.Scope) =>
  `${Subject.notation(subject)}@${scope}`;

/**
 * The rows of a domain with the subjects that effx cannot state. A command or read named by such a row leaves the
 * description whole (a description that granted it to the subjects it can state would answer "no" for the others, and
 * the kernel answers "yes"), and each of these subjects is a gap with the names that it took away.
 */
const lostSubjects = (declaration: Declaration) => {
  const lost = Arr.flatMap(declaration.table, (row) =>
    Arr.flatMap(row.subjects, (subject) =>
      Option.isNone(expressionOf(subject, row.scope))
        ? Arr.map(row.commands, (name) => ({
            name,
            subject: Subject.notation(subject),
          }))
        : []
    )
  );

  const gaps = Arr.map(
    Rec.values(Arr.groupBy(lost, ({ subject }) => subject)),
    (group) =>
      Gap.cases.UnexpressibleSubject.make({
        commands: Arr.dedupe(Arr.map(group, ({ name }) => name)),
        domain: declaration.name,
        subject: group[0].subject,
      })
  );

  return { gaps, names: new Set(Arr.map(lost, ({ name }) => name)) };
};

/** The subject sets and grant rows of the names that stay: one set per subject and scope, a `Union` for a row of several. */
const grantsOf = (declaration: Declaration, kept: ReadonlySet<string>) => {
  const rows = Arr.flatMap(declaration.table, (row) => {
    const permits = Arr.filter(row.commands, (name) => kept.has(name));

    const stated = Arr.flatMap(row.subjects, (subject) =>
      Option.match(expressionOf(subject, row.scope), {
        onNone: () => [],
        onSome: (expression) => [
          {
            notation: Subject.notation(subject),
            set: { expression, name: setName(subject, row.scope) },
          },
        ],
      })
    );

    if (Arr.isReadonlyArrayEmpty(permits) || Arr.isReadonlyArrayEmpty(stated)) {
      return [];
    }

    const singles = Arr.map(stated, ({ set }) => set);

    const union: SubjectSet = {
      expression: Expression.cases.Union.make({
        sets: Arr.map(singles, ({ name }) => name),
      }),
      name: `${Arr.join(
        Arr.map(stated, ({ notation }) => notation),
        " + "
      )}@${row.scope}`,
    };

    const only = Arr.head(singles);

    return [
      {
        grant: {
          permits,
          scope: row.scope,
          subject:
            stated.length === 1 && Option.isSome(only)
              ? only.value.name
              : union.name,
        },
        sets: stated.length === 1 ? singles : [...singles, union],
      },
    ];
  });

  return {
    grants: Arr.map(rows, ({ grant }) => grant),
    subjectSets: Arr.dedupeWith(
      Arr.flatMap(rows, ({ sets }): readonly SubjectSet[] => sets),
      (left: SubjectSet, right: SubjectSet) => left.name === right.name
    ),
  };
};

// ---------------------------------------------------------------- guards

/** The ids that effx knows, for the closed vocabulary of `guard.ts`. */
const effxIds = {
  after: "effx/order/after",
  not: "effx/guard/not",
  or: "effx/guard/or",
  same: "effx/order/same",
} as const;

/** The kernel's own representation of a guard, read back: the checks of the context schema and their operands. */
interface KernelContext {
  readonly checks: readonly KernelCheck[];
}

type KernelCheck =
  | {
      readonly _tag: "Filter";
      readonly representation?: {
        readonly id: string;
        readonly payload: Json;
        readonly schemas?: readonly KernelContext[];
      };
    }
  | { readonly _tag: "FilterGroup"; readonly checks: readonly KernelCheck[] };

const KernelContext: Schema.Codec<KernelContext> = Schema.Struct({
  checks: Schema.Array(
    Schema.suspend((): Schema.Codec<KernelCheck> => KernelCheck)
  ),
});

const KernelCheck: Schema.Codec<KernelCheck> = Schema.Union([
  Schema.TaggedStruct("Filter", {
    representation: Schema.optionalKey(
      Schema.Struct({
        id: Schema.String,
        payload: Schema.Json,
        schemas: Schema.optionalKey(
          Schema.Array(
            Schema.suspend((): Schema.Codec<KernelContext> => KernelContext)
          )
        ),
      })
    ),
  }),
  Schema.TaggedStruct("FilterGroup", {
    checks: Schema.Array(
      Schema.suspend((): Schema.Codec<KernelCheck> => KernelCheck)
    ),
  }),
]);

const KernelGuard = Schema.Struct({ representation: KernelContext });

const Comparison = Schema.Struct({
  left: Schema.Array(Schema.String),
  right: Schema.Array(Schema.String),
});

/** What effx reads as an all-of group of checks. */
const Group = Schema.TaggedStruct("FilterGroup", {
  checks: Schema.Array(Schema.Json),
});

/** A guard in effx's words, with the ids it could not translate and the semester paths that it reads. */
interface Translated {
  readonly json: Json;
  readonly paths: readonly (readonly string[])[];
  readonly unknown: readonly string[];
}

const unknownCheck = (id: string): Translated => ({
  json: null,
  paths: [],
  unknown: [id],
});

/** The checks of one level as effx reads them: one check is itself, several are all of them (`FilterGroup`). */
const together = (parts: readonly Translated[]): Translated => {
  const [only] = parts;

  return {
    json:
      parts.length === 1 && only !== undefined
        ? only.json
        : Group.make({ checks: Arr.map(parts, ({ json }) => json) }),
    paths: Arr.flatMap(parts, ({ paths }) => paths),
    unknown: Arr.flatMap(parts, ({ unknown }) => unknown),
  };
};

/** A check of the kernel in effx's words; `not` and `or` carry the contexts that they apply to. */
const translate = (check: KernelCheck): Translated => {
  if (Predicate.isTagged(check, "FilterGroup")) {
    return together(Arr.map(check.checks, translate));
  }

  if (check.representation === undefined) {
    return unknownCheck("an opaque filter");
  }

  const { id, payload, schemas } = check.representation;

  if (id === Guard.ids.after || id === Guard.ids.same) {
    return Option.match(Schema.decodeUnknownOption(Comparison)(payload), {
      onNone: () => unknownCheck(id),
      onSome: (comparison) => ({
        json: {
          id: id === Guard.ids.after ? effxIds.after : effxIds.same,
          payload: comparison,
        },
        paths: [comparison.left, comparison.right],
        unknown: [],
      }),
    });
  }

  const operands = Arr.map(schemas ?? [], (schema) =>
    together(Arr.map(schema.checks, translate))
  );

  const wrapped = {
    paths: Arr.flatMap(operands, ({ paths }) => paths),
    unknown: Arr.flatMap(operands, ({ unknown }) => unknown),
  };

  if (id === Guard.ids.not && operands.length === 1) {
    return {
      ...wrapped,
      json: { id: effxIds.not, payload: operands[0]?.json ?? null },
    };
  }

  return id === Guard.ids.or && operands.length > 0
    ? {
        ...wrapped,
        json: {
          id: effxIds.or,
          payload: Arr.map(operands, ({ json }) => json),
        },
      }
    : unknownCheck(id);
};

/** A guard's representation in effx's words. One that cannot be read is a guard that cannot be translated. */
const translateRepresentation = (representation: Json): Translated =>
  Option.match(Schema.decodeUnknownOption(KernelGuard)(representation), {
    onNone: () => unknownCheck("an unreadable guard"),
    onSome: ({ representation: context }) =>
      together(Arr.map(context.checks, translate)),
  });

/** A transition's guard, translated: none when the transition has none. */
const translateGuard = (
  transition: MachineDescription["transitions"][number]
): Option.Option<Translated> =>
  Option.map(
    Option.fromNullishOr(transition.guardRepresentation),
    translateRepresentation
  );

// ---------------------------------------------------------------- machines

const pathKey = (path: readonly string[]): string => Arr.join(path, ".");

/** The commands of a domain that apply a machine, by their `Info`. */
const appliedBy = (declaration: Declaration, machine: string) =>
  Arr.flatMap(declaration.commands, (rpc) =>
    Option.exists(
      Option.flatMapNullishOr(Commands.infoOf(rpc), (info) => info.machine),
      (name) => name === machine
    )
      ? [rpc._tag]
      : []
  );

/** A transition that is to be given to effx, by its command or, when time makes it, by `Planned → Active`. */
interface TranslatedTransition {
  readonly guard: Option.Option<Translated>;
  readonly transition: string;
}

/** Why a machine cannot be given whole, in the order that a reader would fix it, with the gaps that say so. */
const blockers = (
  declaration: Declaration,
  machine: MachineDescription,
  kept: ReadonlySet<string>,
  translated: readonly TranslatedTransition[]
) => {
  const domain = declaration.name;
  const guards = Arr.flatMap(translated, ({ guard }) => Option.toArray(guard));

  const unknown = Arr.flatMap(translated, ({ guard, transition }) =>
    Arr.map(
      Option.match(guard, {
        onNone: () => [],
        onSome: ({ unknown: ids }) => ids,
      }),
      (id) =>
        Gap.cases.UnexpressibleGuard.make({
          domain,
          id,
          machine: machine.name,
          transition,
        })
    )
  );

  const declared = new Set(
    Arr.map(machine.fields, ({ path }) => pathKey(path))
  );

  const undeclared = Arr.dedupeWith(
    Arr.filter(
      Arr.flatMap(guards, ({ paths }) => paths),
      (path) => !declared.has(pathKey(path))
    ),
    (left: readonly string[], right: readonly string[]) =>
      pathKey(left) === pathKey(right)
  );

  const lostCommands = Arr.dedupe(
    Arr.flatMap(machine.transitions, ({ command }) =>
      kept.has(command) ? [] : [command]
    )
  );

  const reasons = [
    ...(Arr.isReadonlyArrayEmpty(unknown)
      ? []
      : [dropReasons.unknownCheck.say]),
    ...(Arr.isReadonlyArrayEmpty(undeclared)
      ? []
      : [dropReasons.undeclaredSemester.say]),
    ...(Arr.isReadonlyArrayEmpty(lostCommands)
      ? []
      : [dropReasons.lostCommand.say(Arr.join(lostCommands, ", "))]),
  ];

  const gaps = [
    ...unknown,
    ...(Arr.isReadonlyArrayEmpty(undeclared)
      ? []
      : [
          Gap.cases.MissingDeclaration.make({
            domain,
            machine: machine.name,
            paths: undeclared,
          }),
        ]),
    ...Arr.map(reasons, (reason) =>
      Gap.cases.MachineDropped.make({ domain, machine: machine.name, reason })
    ),
  ];

  return { gaps, reasons };
};

const exportGuard = (guard: Translated, context: string): EffxGuard => ({
  context,
  representation: guard.json,
});

/** A transition in effx's words: the guard is there when the kernel's has been translated. */
const exportTransition = (
  transition: MachineDescription["transitions"][number],
  guard: Option.Option<Translated>,
  contextName: string
): EffxTransition => ({
  command: transition.command,
  from: transition.from,
  guard: Option.getOrUndefined(
    Option.map(guard, (found) => exportGuard(found, contextName))
  ),
  to: transition.to,
});

interface ExportedMachine {
  readonly gaps: readonly Gap[];
  readonly machine: Option.Option<EffxMachine>;
}

const exportMachine = (
  declaration: Declaration,
  machine: MachineDescription,
  kept: ReadonlySet<string>
): ExportedMachine => {
  const domain = declaration.name;
  const contextName = `${machine.name}Context`;

  const translated = Arr.map(machine.transitions, (transition) => ({
    guard: translateGuard(transition),
    transition: transition.command,
  }));

  const changes = Arr.map(machine.calculated, (change) => ({
    from: change.from,
    guard: translateRepresentation(change.guardRepresentation),
    to: change.to,
  }));

  const { gaps, reasons } = blockers(declaration, machine, kept, [
    ...translated,
    ...Arr.map(changes, ({ from, guard, to }) => ({
      guard: Option.some(guard),
      transition: `${from} → ${to}`,
    })),
  ]);

  if (!Arr.isReadonlyArrayEmpty(reasons)) {
    return { gaps, machine: Option.none() };
  }

  const clock = Arr.findFirst(machine.fields, ({ kind }) => kind === "clock");

  const writes = Arr.filter(appliedBy(declaration, machine.name), (command) =>
    kept.has(command)
  );

  const exported: EffxMachine = {
    calculated: Arr.map(changes, ({ from, guard, to }) => ({
      from,
      to,
      when: exportGuard(guard, contextName),
    })),
    context: {
      clockPath: Option.getOrUndefined(Option.map(clock, ({ path }) => path)),
      fields: Arr.map(machine.fields, ({ kind, path }) => ({
        kind,
        order: SEMESTER_ORDER,
        path,
      })),
      name: contextName,
    },
    name: machine.name,
    states: machine.states,
    terminal: machine.terminal,
    transitions: Arr.map(machine.transitions, (transition, index) =>
      exportTransition(
        transition,
        translated[index]?.guard ?? Option.none(),
        contextName
      )
    ),
  };

  const stored = Arr.some(machine.fields, ({ kind }) => kind === "stored");

  return {
    gaps:
      stored && !Arr.isReadonlyArrayEmpty(writes)
        ? [
            Gap.cases.UndeclaredWrites.make({
              commands: writes,
              domain,
              machine: machine.name,
            }),
          ]
        : [],
    machine: Option.some(exported),
  };
};

// ---------------------------------------------------------------- the admin list

interface AdminList {
  readonly adminList: Option.Option<{
    readonly grant: string;
    readonly revoke: string;
  }>;
  readonly gaps: readonly Gap[];
}

/** The commands that grant and revoke a place on the admin list, by ADR 0010: resource `AdminGrant`, `create` and `delete`. */
const adminListOf = (
  declaration: Declaration,
  kept: ReadonlySet<string>
): AdminList => {
  const named = (method: Commands.Method) =>
    Arr.flatMap(declaration.commands, (rpc) =>
      Option.exists(
        Commands.infoOf(rpc),
        (info) =>
          info.resource === "AdminGrant" &&
          info.method === method &&
          kept.has(rpc._tag)
      )
        ? [rpc._tag]
        : []
    );

  const grants = named("create");
  const revokes = named("delete");

  if (Arr.isReadonlyArrayEmpty(grants) && Arr.isReadonlyArrayEmpty(revokes)) {
    return { adminList: Option.none(), gaps: [] };
  }

  const pair =
    grants.length === 1 && revokes.length === 1
      ? Option.all({ grant: Arr.head(grants), revoke: Arr.head(revokes) })
      : Option.none();

  return {
    adminList: pair,
    gaps: Option.isSome(pair)
      ? [Gap.cases.AdminExpiry.make({ domain: declaration.name })]
      : [
          Gap.cases.AdminListUnclear.make({
            domain: declaration.name,
            grants,
            revokes,
          }),
        ],
  };
};

// ---------------------------------------------------------------- the description

const commandOf = (rpc: Declaration["commands"][number]): EffxCommand => ({
  kind: "Command",
  name: rpc._tag,
  runBy: Option.getOrUndefined(
    Option.map(
      Option.flatMapNullishOr(Commands.infoOf(rpc), (info) => info.job),
      (job) => ({ job })
    )
  ),
});

/**
 * The description of one domain, and what it could not say. A domain with no command or read that effx can state has
 * no description (`NoDescription`).
 */
export const describe = (declaration: Declaration): Export => {
  const lost = lostSubjects(declaration);

  const kept = new Set(
    Arr.filter(namesOf(declaration), (name) => !lost.names.has(name))
  );

  const { grants, subjectSets } = grantsOf(declaration, kept);

  const machines = Arr.map(declaration.machines, (machine) =>
    exportMachine(declaration, machine, kept)
  );

  const exported = Arr.flatMap(machines, ({ machine }) =>
    Option.toArray(machine)
  );

  const admin = adminListOf(declaration, kept);

  const commands = Arr.map(
    Arr.filter(declaration.commands, (rpc) => kept.has(rpc._tag)),
    commandOf
  );

  const reads = Arr.flatMap(Rec.keys(declaration.reads), (name) =>
    kept.has(name) ? [{ name }] : []
  );

  const gaps = [
    ...lost.gaps,
    ...Arr.flatMap(machines, (result) => result.gaps),
    ...admin.gaps,
  ];

  if (Arr.isReadonlyArrayEmpty(commands) && Arr.isReadonlyArrayEmpty(reads)) {
    return {
      description: Option.none(),
      gaps: [
        ...gaps,
        Gap.cases.NoDescription.make({
          domain: declaration.name,
          reason: "no command or read of the domain can be stated to effx",
        }),
      ],
    };
  }

  const { memberships } = declaration;

  const bound =
    memberships !== null &&
    Arr.some(exported, ({ name }) => name === memberships.machine);

  const description: EffxDescription = {
    adminList: Option.getOrUndefined(admin.adminList),
    clock: Arr.some(exported, ({ context }) => context.clockPath !== undefined)
      ? { order: SEMESTER_ORDER }
      : undefined,
    commands,
    grants,
    machines: exported,
    memberships: bound
      ? {
          grantingStates: memberships.grantingStates,
          machine: memberships.machine,
        }
      : undefined,
    name: declaration.name,
    orders: Arr.some(exported, ({ context }) => context.fields.length > 0)
      ? [{ name: SEMESTER_ORDER }]
      : [],
    principals: {
      Anonymous: {},
      Person: {},
      System: { jobs: SystemJob.literals },
    },
    reads,
    subjectSets,
  };

  return { description: Option.some(description), gaps };
};

// ---------------------------------------------------------------- the committed form

/** What is committed: a description, or the register of gaps in the form that the schema encodes. */
export type Committable = EffxDescription | readonly (typeof Gap.Encoded)[];

/**
 * The committed form of a description or a register: two-space indent and one final newline. The keys come out in
 * the order that the export writes them, which is the alphabetical order that the lint rule asks of every literal.
 */
export const committedJson = (value: Committable): string =>
  `${JSON.stringify(value, null, 2)}\n`;
