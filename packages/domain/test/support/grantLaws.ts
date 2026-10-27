/**
 * The test side of `authorize` (spec 0006, falsifier 1). Generators build principals over a few departments, teams
 * and persons, so that a department or a person that a grant row names turns up often, and an oracle reads a grant
 * table by a second route: it lists the atoms a principal belongs to (`Leader` in department 2, `Admin`, …) and asks
 * whether a row needs one of them. `authorize` reads the same rows by evaluating each subject set against the
 * principal. The two routes share no code.
 */
import { assert } from "@effect/vitest";
import {
  Arbitrary,
  Array as Arr,
  DateTime,
  Effect,
  Predicate,
  Schema,
} from "effect";

import {
  CodePurpose,
  DepartmentId,
  PersonId,
  Principal,
  Subject,
  SystemJob,
  TeamFunction,
  TeamId,
  codePolicy,
} from "../../src/index.ts";
import type {
  Grant,
  MembershipFact,
  PersonPrincipal,
  Resource,
} from "../../src/index.ts";

const upTo = (limit: number) => Schema.Literals(Arr.range(1, limit));

const departments = Arbitrary.map(Arbitrary.schema(upTo(3)), (id) =>
  DepartmentId.make(id)
);

const teams = Arbitrary.map(Arbitrary.schema(upTo(4)), (id) => TeamId.make(id));

const persons = Arbitrary.map(Arbitrary.schema(upTo(5)), (id) =>
  PersonId.make(id)
);

const membership = Arbitrary.all({
  departmentId: departments,
  function: Arbitrary.schema(TeamFunction),
  leader: Arbitrary.schema(Schema.Boolean),
  teamId: teams,
});

const personFacts = Arbitrary.all({
  admin: Arbitrary.schema(Schema.Boolean),
  memberships: Arbitrary.array(membership, { maxLength: 3 }),
  personId: persons,
});

/** Construct a person from facts, including a long-lived admin place when requested. */
export const principalOf = (
  memberships: readonly MembershipFact[],
  personId: PersonId,
  admin: boolean
): PersonPrincipal =>
  admin
    ? Principal.cases.Person.make({
        adminUntil: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
        memberships,
        personId,
      })
    : Principal.cases.Person.make({ memberships, personId });

const person = Arbitrary.map(personFacts, ({ admin, memberships, personId }) =>
  principalOf(memberships, personId, admin)
);

const narrowedPerson = Arbitrary.map(
  Arbitrary.all({ facts: personFacts, purpose: Arbitrary.schema(CodePurpose) }),
  ({ facts, purpose }) =>
    Principal.narrow(
      principalOf(facts.memberships, facts.personId, facts.admin),
      {
        command: codePolicy[purpose].command,
        resource: { personId: facts.personId },
      }
    )
);

/** A generated property must pass; include its counterexample in the failure. */
export const passes = <A, E>(result: Arbitrary.CheckResult<A, E>) => {
  assert.strictEqual(
    result._tag,
    "Passed",
    Arbitrary.formatCheckFailure(result)
  );
};

const system = Arbitrary.map(Arbitrary.schema(SystemJob), (job) =>
  Principal.cases.System.make({ job })
);

const anonymous = Arbitrary.Constant(Principal.cases.Anonymous.make({}));

const principalKinds = { anonymous, narrowedPerson, person, system } as const;

/** Persons mostly, but also every other kind of principal. */
export const principals: Arbitrary.Arbitrary<Principal> = Arbitrary.flatMap(
  Arbitrary.schema(
    Schema.Literals([
      "person",
      "person",
      "narrowedPerson",
      "narrowedPerson",
      "system",
      "anonymous",
    ])
  ),
  (kind): Arbitrary.Arbitrary<Principal> => principalKinds[kind]
);

const departmentOnly = Arbitrary.map(departments, (departmentId) => ({
  departmentId,
}));

const personOnly = Arbitrary.map(persons, (personId) => ({ personId }));

const both = Arbitrary.all({ departmentId: departments, personId: persons });

const neither = Arbitrary.Constant({});

const resourceKinds = { both, departmentOnly, neither, personOnly } as const;

/** What a command may be about: a department, a person, both, neither. */
export const resources: Arbitrary.Arbitrary<Resource> = Arbitrary.flatMap(
  Arbitrary.schema(
    Schema.Literals(["both", "departmentOnly", "neither", "personOnly"])
  ),
  (kind) => resourceKinds[kind]
);

/** One check of a property: a principal acting on a resource. */
export const cases = Arbitrary.all({
  principal: principals,
  resource: resources,
});

// ---------------------------------------------------------------- the oracle

/** One thing a principal can be, with the department it holds in when it has one. */
type Atom =
  | { readonly kind: "anyone" }
  | { readonly kind: "admin" }
  | { readonly kind: "system"; readonly job: SystemJob }
  | { readonly kind: "self"; readonly personId: PersonId }
  | {
      readonly kind: "holder";
      readonly personId: PersonId;
      readonly purpose: CodePurpose;
    }
  | {
      readonly kind: "member" | "leader";
      readonly departmentId: DepartmentId;
    }
  | {
      readonly kind: "fn";
      readonly function: TeamFunction;
      readonly departmentId: DepartmentId;
    };

const atomsOf = (principal: Principal): readonly Atom[] =>
  Principal.match(principal, {
    Anonymous: (): readonly Atom[] => [{ kind: "anyone" }],
    Person: (facts): readonly Atom[] => [
      { kind: "anyone" },
      { kind: "self", personId: facts.personId },
      ...(facts.adminUntil === undefined ? [] : [{ kind: "admin" } as const]),
      ...Arr.flatMap(CodePurpose.literals, (purpose): readonly Atom[] =>
        Arr.some(
          facts.narrowing ?? [],
          (restriction) =>
            restriction.command === codePolicy[purpose].command &&
            restriction.resource.personId === facts.personId
        )
          ? [{ kind: "holder", personId: facts.personId, purpose }]
          : []
      ),
      ...Arr.flatMap(facts.memberships, (m): readonly Atom[] => [
        { departmentId: m.departmentId, kind: "member" },
        ...(m.leader
          ? [{ departmentId: m.departmentId, kind: "leader" } as const]
          : []),
        { departmentId: m.departmentId, function: m.function, kind: "fn" },
      ]),
    ],
    System: (facts): readonly Atom[] => [
      { kind: "anyone" },
      { job: facts.job, kind: "system" },
    ],
  });

/** Whether the department an atom holds in is the one the grant is about. */
const holdsIn = (
  scope: Grant.Scope,
  resource: Resource,
  departmentId: DepartmentId
): boolean =>
  scope === "all" ||
  (scope === "department" && resource.departmentId === departmentId);

/** Whether one atom is what `subject` needs under `scope` about `resource`. */
const satisfies = (
  atom: Atom,
  subject: Subject.Any,
  scope: Grant.Scope,
  resource: Resource
): boolean =>
  Subject.Any.match(subject, {
    Admin: () => scope === "all" && atom.kind === "admin",
    Anyone: () => scope === "all" && atom.kind === "anyone",
    Fn: ({ function: teamFunction }) =>
      atom.kind === "fn" &&
      atom.function === teamFunction &&
      holdsIn(scope, resource, atom.departmentId),
    Holder: ({ purpose }) =>
      scope === "own" &&
      atom.kind === "holder" &&
      atom.purpose === purpose &&
      resource.personId === atom.personId,
    Leader: () =>
      atom.kind === "leader" && holdsIn(scope, resource, atom.departmentId),
    Member: () =>
      atom.kind === "member" && holdsIn(scope, resource, atom.departmentId),
    Self: () =>
      scope === "own" &&
      atom.kind === "self" &&
      resource.personId === atom.personId,
    System: ({ job }) =>
      scope === "all" && atom.kind === "system" && atom.job === job,
  });

/** What the table says about one command, read through the atoms of the principal. */
export const oracle = (
  table: readonly Grant.Row[],
  principal: Principal,
  command: string,
  resource: Resource
): boolean => {
  const atoms = atomsOf(principal);

  if (
    Predicate.isTagged(principal, "Person") &&
    principal.narrowing !== undefined
  ) {
    for (const restriction of principal.narrowing) {
      if (
        restriction.command !== command ||
        restriction.resource.personId !== resource.personId ||
        restriction.resource.departmentId !== resource.departmentId
      ) {
        return false;
      }
    }
  }

  return Arr.some(
    Arr.filter(table, (row) => Arr.contains(row.commands, command)),
    (row) =>
      Arr.some(row.subjects, (subject) =>
        Arr.some(atoms, (atom) => satisfies(atom, subject, row.scope, resource))
      )
  );
};

/** The table without row `index`. */
export const without = <Row>(
  table: readonly Row[],
  index: number
): readonly Row[] => Arr.filter(table, (_, at) => at !== index);

/**
 * Checks that `candidate` answers like the oracle over `table` for `command`: `Passed` when it does for every
 * generated case, `Falsified` with a counterexample when it does not.
 */
export const agreement = (
  table: readonly Grant.Row[],
  candidate: (
    principal: Principal,
    command: string,
    resource: Resource
  ) => boolean,
  command: string
) =>
  Arbitrary.checkEffect(
    cases,
    ({ principal, resource }) =>
      Effect.succeed(
        candidate(principal, command, resource) ===
          oracle(table, principal, command, resource)
      ),
    { runs: 600, seed: 20_261_026 }
  );
