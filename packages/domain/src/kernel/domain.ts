/**
 * A domain's declaration: its commands (one `RpcGroup`), the reads it guards, its grant rows and its machines. The
 * declaration is data. The grant table, the handlers' authorization, the completeness tests and the generated
 * reference (`tools/docgen`) all read it, and nothing else states who may do what.
 *
 * `make` adds the one `Admin` row (an admin holds every command that a person may run, with scope `all`; the
 * commands that only a job runs are not among them, R1) and binds `handle`, which every handler is built with, so a
 * handler cannot run before the grant table has allowed it.
 */
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Predicate,
  Record as Rec,
} from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { Rpc, RpcGroup } from "effect/rpc";

import { codePolicy } from "../accounts/code.ts";
import type { CodePurpose } from "../accounts/code.ts";
import type { Forbidden } from "../shared/errors.ts";
import { PersonId } from "../shared/ids.ts";
import type { DepartmentId } from "../shared/ids.ts";
import {
  authorizeWith,
  canAnywhereWith,
  requireGrantWith,
} from "./authorize.ts";
import type { Authorize, CanAnywhere, RequireGrant } from "./authorize.ts";
import * as Commands from "./commands.ts";
import * as Grant from "./grant.ts";
import { Boundary } from "./machine.ts";
import type { Description } from "./machine.ts";
import { Principal } from "./principal.ts";
import type { CurrentPrincipal, SystemJob } from "./principal.ts";
import * as Subject from "./subject.ts";

export { Info, info } from "./commands.ts";

export { make as grant } from "./grant.ts";

export {
  anyone,
  board,
  holder,
  leader,
  member,
  self,
  system,
} from "./subject.ts";

/** A read the domain guards by name (a page, a list): it has a grant but no transition and no handler. */
export interface ReadInfo {
  readonly summary: string;
  readonly replaces: readonly string[];
}

/** The resource of a command whose payload names its department. */
export const departmentResource = ({
  departmentId,
}: {
  readonly departmentId: DepartmentId;
}) => Effect.succeed({ departmentId });

/** The names a grant row of a domain may carry: the tags of its group and the names of its reads. */
export type CommandOf<Rpcs extends Rpc.Any, Reads extends string> =
  | Rpcs["_tag"]
  | Reads;

/** What the tests and the doc generator read of a domain. `Command` is the names a grant row may carry. */
export interface Declaration<Command extends string = string> {
  readonly name: string;
  /** The heading of the domain's page in `docs/system/`. */
  readonly title: string;
  readonly commands: readonly Rpc.Any[];
  readonly reads: Readonly<Record<string, ReadInfo>>;
  readonly machines: readonly Description[];
  /** The rows as the domain wrote them. */
  readonly declared: readonly Grant.Row<Command>[];
  /** What a person may run or open: the commands that no job alone runs, and the reads. An admin holds all of them. */
  readonly personal: readonly Command[];
  /** The permission table of this domain alone: the declared rows and its admin row. */
  readonly table: readonly Grant.Row<Command>[];
}

/** What a command's handler spells out; `Domain.handle` supplies the rest. */
export interface HandlerSpec<
  C extends Rpc.Any,
  ResourceError,
  ResourceServices,
  RunError,
  RunServices,
> {
  /** What the command is about: the department of the record, the person it belongs to (all of them, for a move). */
  readonly resource: (
    payload: Rpc.Payload<C>
  ) => Effect.Effect<
    Subject.Resource | NonEmptyReadonlyArray<Subject.Resource>,
    ResourceError,
    ResourceServices
  >;
  /** The command itself, once the grant table has allowed the principal. */
  readonly run: (
    payload: Rpc.Payload<C>,
    principal: Principal
  ) => Effect.Effect<Rpc.Success<C>, RunError, RunServices>;
}

export interface Domain<
  Rpcs extends Rpc.Any,
  Reads extends string,
> extends Declaration<CommandOf<Rpcs, Reads>> {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly authorize: Authorize<CommandOf<Rpcs, Reads>>;
  readonly canAnywhere: CanAnywhere<CommandOf<Rpcs, Reads>>;
  readonly requireGrant: RequireGrant<CommandOf<Rpcs, Reads>>;
  /**
   * A handler for `rpc`: it finds what the command is about (`resource`), asks the grant table about every one of
   * those resources, and only then runs the command. Handlers are built only here, so the authorization step is not
   * the handler author's to forget.
   */
  readonly handle: <
    const C extends Rpcs,
    ResourceError,
    ResourceServices,
    RunError,
    RunServices,
  >(
    rpc: C,
    spec: HandlerSpec<C, ResourceError, ResourceServices, RunError, RunServices>
  ) => (
    payload: Rpc.Payload<C>
  ) => Effect.Effect<
    Rpc.Success<C>,
    ResourceError | RunError | Forbidden,
    ResourceServices | RunServices | CurrentPrincipal
  >;
}

/** Every name that a domain's grant rows may carry (its commands and its reads). */
export type NamesOf<Declared> =
  Declared extends Domain<infer Rpcs, infer Reads>
    ? CommandOf<Rpcs, Reads>
    : never;

/** The job that alone runs a command, `null` when a person may run it. */
const jobOf = (rpc: Rpc.Any): SystemJob | null =>
  Commands.infoOf(rpc).pipe(
    Option.flatMapNullishOr((info) => info.job),
    Option.getOrNull
  );

/** The code purpose that alone runs a command, if any. */
const credentialOf = (rpc: Rpc.Any): CodePurpose | null =>
  Commands.infoOf(rpc).pipe(
    Option.flatMapNullishOr((info) => info.credential),
    Option.getOrNull
  );

/**
 * Declares a domain. `grants` are typed by the group: a row that names a command outside it does not compile.
 * `reads` names what the domain guards besides commands.
 */
export const make = <
  const Rpcs extends Rpc.Any,
  const Reads extends string = never,
>(declaration: {
  readonly name: string;
  readonly title: string;
  readonly commands: RpcGroup.RpcGroup<Rpcs>;
  readonly reads: { readonly [Read in Reads]: ReadInfo };
  readonly grants: readonly Grant.Row<NoInfer<CommandOf<Rpcs, Reads>>>[];
  readonly machines?: readonly Description[];
}): Domain<Rpcs, Reads> => {
  const rpcs = Arr.fromIterable(declaration.commands.requests.values());

  const personal: readonly CommandOf<Rpcs, Reads>[] = [
    ...Arr.flatMap(rpcs, (rpc) =>
      jobOf(rpc) === null && credentialOf(rpc) === null ? [rpc._tag] : []
    ),
    ...Rec.keys(declaration.reads),
  ];

  const adminRows = Arr.isReadonlyArrayNonEmpty(personal)
    ? [Grant.make([Subject.admin], personal, "all")]
    : [];

  const table = [...declaration.grants, ...adminRows];
  const requireGrant = requireGrantWith(table);

  const handle: Domain<Rpcs, Reads>["handle"] = (rpc, spec) =>
    Effect.fn(rpc._tag)(function* handler(payload) {
      const resources = yield* spec.resource(payload);
      const principal = yield* requireGrant(rpc._tag, resources);

      return yield* spec.run(payload, principal);
    });

  return {
    authorize: authorizeWith(table),
    canAnywhere: canAnywhereWith(table),
    commands: rpcs,
    declared: declaration.grants,
    group: declaration.commands,
    handle,
    machines: declaration.machines ?? [],
    name: declaration.name,
    personal,
    reads: declaration.reads,
    requireGrant,
    table,
    title: declaration.title,
  };
};

// ---------------------------------------------------------------- completeness

const namesOf = (declaration: Declaration): readonly string[] => [
  ...Arr.map(declaration.commands, (rpc) => rpc._tag),
  ...Rec.keys(declaration.reads),
];

const rowsNaming = (declaration: Declaration, command: string) =>
  Arr.filter(declaration.table, (row) => Arr.contains(row.commands, command));

const scopeFits = (subject: Subject.Any, scope: Subject.Scope): boolean =>
  Subject.Any.match(subject, {
    Admin: () => scope === "all",
    Anyone: () => scope === "all",
    Fn: () => scope !== "own",
    Holder: () => scope === "own",
    Leader: () => scope !== "own",
    Member: () => scope !== "own",
    Self: () => scope === "own",
    System: () => scope === "all",
  });

/** The job of a `System` subject, `null` for every other subject set. */
const systemJob = (subject: Subject.Any): SystemJob | null =>
  Predicate.isTagged(subject, "System") ? subject.job : null;

const ungranted = (declaration: Declaration) =>
  Arr.flatMap(namesOf(declaration), (name) =>
    Arr.isReadonlyArrayEmpty(rowsNaming(declaration, name))
      ? [`${name} has no grant`]
      : []
  );

const unknown = (declaration: Declaration) =>
  Arr.flatMap(declaration.table, (row) =>
    Arr.flatMap(row.commands, (command) =>
      Arr.contains(namesOf(declaration), command)
        ? []
        : [
            `a grant names ${command}, which is neither a command nor a read of ${declaration.name}`,
          ]
    )
  );

const unannotated = (declaration: Declaration) =>
  Arr.flatMap(declaration.commands, (rpc) =>
    Option.isNone(Commands.infoOf(rpc))
      ? [`${rpc._tag} carries no Info annotation`]
      : []
  );

const misfitScopes = (declaration: Declaration) =>
  Arr.flatMap(declaration.table, (row) =>
    Arr.flatMap(row.subjects, (subject) =>
      scopeFits(subject, row.scope)
        ? []
        : [
            `${Subject.notation(subject)} cannot be granted with the scope ${row.scope}`,
          ]
    )
  );

/**
 * A job's command is granted to its own `System` principal and to nobody else; `System(job)` is granted the
 * commands of that job and no other.
 */
const jobGrants = (declaration: Declaration) =>
  Arr.flatMap(declaration.commands, (rpc) => {
    const job = jobOf(rpc);

    const owner =
      job === null ? "not a job's command" : `the ${job} job's command`;

    return Arr.flatMap(rowsNaming(declaration, rpc._tag), (row) =>
      Arr.flatMap(row.subjects, (subject) =>
        systemJob(subject) === job
          ? []
          : [
              `${rpc._tag} is ${owner}, but ${Subject.notation(subject)} is granted it`,
            ]
      )
    );
  });

/** A code-only command is granted solely to the holder of that purpose. */
const credentialGrants = (declaration: Declaration) =>
  Arr.flatMap(declaration.commands, (rpc) => {
    const purpose = credentialOf(rpc);

    const wrongCommand =
      purpose !== null && codePolicy[purpose].command !== rpc._tag
        ? [`${purpose} is not the credential for ${rpc._tag}`]
        : [];

    return [
      ...wrongCommand,
      ...Arr.flatMap(rowsNaming(declaration, rpc._tag), (row) =>
        Arr.flatMap(row.subjects, (subject) => {
          const holderPurpose = Predicate.isTagged(subject, "Holder")
            ? subject.purpose
            : null;

          return holderPurpose === purpose
            ? []
            : [`${rpc._tag} is not granted to ${Subject.notation(subject)}`];
        })
      ),
    ];
  });

const jobsWithoutGrant = (declaration: Declaration) =>
  Arr.flatMap(declaration.commands, (rpc) => {
    const job = jobOf(rpc);

    return job !== null &&
      !Arr.some(rowsNaming(declaration, rpc._tag), (row) =>
        Arr.some(row.subjects, (subject) => systemJob(subject) === job)
      )
      ? [
          `${rpc._tag} is the ${job} job's command, and System(${job}) holds no grant for it`,
        ]
      : [];
  });

const admin = Principal.cases.Person.make({
  adminUntil: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
  memberships: [],
  personId: PersonId.make(1),
});

/** An admin holds every command and read that a person may run. */
const adminGaps = (declaration: Declaration) => {
  const authorize = authorizeWith(declaration.table);

  const restrictedCommands = Arr.flatMap(declaration.commands, (rpc) =>
    jobOf(rpc) === null && credentialOf(rpc) === null ? [] : [rpc._tag]
  );

  return Arr.flatMap(namesOf(declaration), (name) =>
    Arr.contains(restrictedCommands, name) || authorize(admin, name)
      ? []
      : [`an admin does not hold ${name}`]
  );
};

const machineProblems = (declaration: Declaration) =>
  Arr.flatMap(declaration.machines, (machine) => {
    const known = [...machine.states, Boundary];
    const tags = Arr.map(declaration.commands, (rpc) => rpc._tag);

    const transitions = Arr.flatMap(machine.transitions, (transition) => [
      ...(Arr.contains(tags, transition.command)
        ? []
        : [
            `${machine.name} has a transition for ${transition.command}, which is not a command of ${declaration.name}`,
          ]),
      ...Arr.flatMap([...transition.from, transition.to], (state) =>
        Arr.contains(known, state)
          ? []
          : [
              `${machine.name} has a transition that names the undeclared state ${state}`,
            ]
      ),
    ]);

    const orphans = Arr.flatMap(declaration.commands, (rpc) =>
      Option.exists(
        Option.flatMapNullishOr(Commands.infoOf(rpc), (info) => info.machine),
        (name) => name === machine.name
      ) &&
      !Arr.some(
        machine.transitions,
        (transition) => transition.command === rpc._tag
      )
        ? [
            `${rpc._tag} applies ${machine.name}, which has no transition for it`,
          ]
        : []
    );

    return [...transitions, ...orphans];
  });

/**
 * Everything that makes a declaration incomplete: a command or read without a grant, a grant that names something
 * unknown, a command without its annotation, a subject set paired with a scope it cannot use, a job's command
 * that a person (an admin included) holds, a job that holds no grant, an admin without a person's command, and a
 * machine and its commands that disagree. Empty means complete. The tests assert it for every domain, and the doc
 * generator refuses to render otherwise.
 */
export const problems = (declaration: Declaration): readonly string[] => [
  ...ungranted(declaration),
  ...unknown(declaration),
  ...unannotated(declaration),
  ...misfitScopes(declaration),
  ...jobGrants(declaration),
  ...credentialGrants(declaration),
  ...jobsWithoutGrant(declaration),
  ...adminGaps(declaration),
  ...machineProblems(declaration),
];
