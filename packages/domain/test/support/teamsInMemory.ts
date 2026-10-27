/**
 * In-memory implementations of the teams repositories, for the tests of this package and of `apps/web`
 * (`@vektorprogrammet/domain/testing`). They keep the contracts that `packages/db` keeps with constraints and
 * conditional updates: one e-mail address is one person, a team name is unique within its department, a person's
 * memberships in one team never overlap, and a write that finds the row changed since it was read is a `Conflict`.
 * `packages/db` has the real behaviour under test (`test/teams.postgres.test.ts`); these fakes are as far as the
 * domain's handlers need.
 */
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Predicate,
  Ref,
} from "effect";
import { cast } from "effect/Function";

import {
  AccountRepository,
  AccountState,
  ADMIN_LIST_ID,
  AdminGrantId,
  AdminGrantRepository,
  AggregateLocks,
  AlreadyExists,
  Conflict,
  DigestLedger,
  FieldOfStudyRepository,
  MEMBERSHIP_CHANGED,
  MEMBERSHIP_OVERLAPS,
  MembershipId,
  MembershipRepository,
  NotFound,
  PERSON_EXISTS,
  PersonId,
  PersonRepository,
  PositionId,
  PositionRepository,
  PrincipalDirectory,
  TEAM_EXISTS,
  TeamId,
  TeamRepository,
  WelcomeLedger,
  membershipState,
  personPrincipal,
  semesterOrdinal,
} from "../../src/index.ts";
import type {
  Account,
  ActiveMembership,
  AdminGrant,
  AdminGrantView,
  AggregateRoot,
  EntityName,
  Locked,
  Membership,
  MembershipFact,
  MembershipView,
  Person,
  Position,
  Semester,
  Team,
} from "../../src/index.ts";

/** The value list the migration seeds (`Leder`, `Medlem`), with the ids it gets there. */
export const LEADER_POSITION = PositionId.make(1);

export const MEMBER_POSITION = PositionId.make(2);

/** One `Ref` for the rows of each fake teams table. */
export interface TeamTableRefs {
  readonly accounts: Ref.Ref<readonly Account[]>;
  readonly adminGrants: Ref.Ref<readonly AdminGrant[]>;
  readonly digests: Ref.Ref<ReadonlySet<string>>;
  readonly locks: Ref.Ref<readonly string[]>;
  readonly memberships: Ref.Ref<readonly Membership[]>;
  readonly nextId: Ref.Ref<number>;
  readonly people: Ref.Ref<readonly Person[]>;
  readonly positions: Ref.Ref<readonly Position[]>;
  readonly teams: Ref.Ref<readonly Team[]>;
  readonly welcomes: Ref.Ref<ReadonlySet<number>>;
}

/** Fresh, empty tables, with the seeded position list. */
export const makeTeamTables = (): TeamTableRefs => ({
  accounts: Ref.makeUnsafe<readonly Account[]>([]),
  adminGrants: Ref.makeUnsafe<readonly AdminGrant[]>([]),
  digests: Ref.makeUnsafe<ReadonlySet<string>>(new Set()),
  locks: Ref.makeUnsafe<readonly string[]>([]),
  memberships: Ref.makeUnsafe<readonly Membership[]>([]),
  nextId: Ref.makeUnsafe(1000),
  people: Ref.makeUnsafe<readonly Person[]>([]),
  positions: Ref.makeUnsafe<readonly Position[]>([
    { id: LEADER_POSITION, name: "Leder" },
    { id: MEMBER_POSITION, name: "Medlem" },
  ]),
  teams: Ref.makeUnsafe<readonly Team[]>([]),
  welcomes: Ref.makeUnsafe<ReadonlySet<number>>(new Set()),
});

/** Puts the rows of every table back, as a rolled-back transaction does. */
export type RestoreTeamTables = () => Effect.Effect<void>;

/**
 * The rows of every table now, and how to put them back. The id sequence is not put back, as a database sequence is
 * not.
 */
export const snapshotTeamTables = (tables: TeamTableRefs) =>
  Effect.gen(function* snapshot() {
    const accounts = yield* Ref.get(tables.accounts);
    const adminGrants = yield* Ref.get(tables.adminGrants);
    const digests = yield* Ref.get(tables.digests);
    const memberships = yield* Ref.get(tables.memberships);
    const people = yield* Ref.get(tables.people);
    const positions = yield* Ref.get(tables.positions);
    const teams = yield* Ref.get(tables.teams);
    const welcomes = yield* Ref.get(tables.welcomes);

    const restore: RestoreTeamTables = () =>
      Effect.all(
        [
          Ref.set(tables.accounts, accounts),
          Ref.set(tables.adminGrants, adminGrants),
          Ref.set(tables.digests, digests),
          Ref.set(tables.memberships, memberships),
          Ref.set(tables.people, people),
          Ref.set(tables.positions, positions),
          Ref.set(tables.teams, teams),
          Ref.set(tables.welcomes, welcomes),
        ],
        { discard: true }
      );

    return restore;
  });

/** The fake tables of the teams; tests seed and read them directly. */
export class TeamTables extends Context.Service<TeamTables, TeamTableRefs>()(
  "test/TeamTables"
) {
  static readonly layer = Layer.sync(TeamTables, makeTeamTables);
}

type Tables = TeamTableRefs;

const nextId = (tables: Tables) =>
  Ref.getAndUpdate(tables.nextId, (id) => id + 1);

const findOrNotFound = <A extends { readonly id: number }>(
  rows: Ref.Ref<readonly A[]>,
  entity: EntityName,
  id: number
) =>
  Effect.flatMap(Ref.get(rows), (all) =>
    Effect.mapError(
      Effect.fromOption(Arr.findFirst(all, (row) => row.id === id)),
      () => new NotFound({ entity, key: String(id) })
    )
  );

const byName = <A extends { readonly name: string }>(): Order.Order<A> =>
  Order.mapInput(Order.String, (row: A) => row.name);

const overlaps = (
  left: Pick<Membership, "end" | "start">,
  right: Pick<Membership, "end" | "start">
): boolean =>
  semesterOrdinal(left.start) <= semesterOrdinal(right.end) &&
  semesterOrdinal(right.start) <= semesterOrdinal(left.end);

const sameSemester = (left: Semester, right: Semester): boolean =>
  semesterOrdinal(left) === semesterOrdinal(right);

const overlapping = (rows: readonly Membership[], next: Membership) =>
  Arr.some(
    rows,
    (row) =>
      row.id !== next.id &&
      row.personId === next.personId &&
      row.teamId === next.teamId &&
      overlaps(row, next)
  );

const nameOf = (rows: readonly { id: number; name: string }[], id: number) =>
  Option.match(
    Arr.findFirst(rows, (row) => row.id === id),
    { onNone: () => "", onSome: (row) => row.name }
  );

const lostRace = (id: MembershipId) =>
  new Conflict({
    entity: "Membership",
    key: String(id),
    message: MEMBERSHIP_CHANGED,
  });

const overlapRefused = (membership: Membership) =>
  new AlreadyExists({
    entity: "Membership",
    key: String(membership.id),
    message: MEMBERSHIP_OVERLAPS,
  });

const personRepository = Layer.effect(
  PersonRepository,
  Effect.gen(function* personRepository() {
    const tables = yield* TeamTables;
    const fields = yield* FieldOfStudyRepository;

    return PersonRepository.of({
      create: (draft) =>
        Effect.gen(function* create() {
          const people = yield* Ref.get(tables.people);

          if (Arr.some(people, (person) => person.email === draft.email)) {
            return yield* new AlreadyExists({
              entity: "Person",
              key: draft.email,
              message: PERSON_EXISTS,
            });
          }

          const field = yield* Effect.orDie(
            fields.findById(draft.fieldOfStudyId)
          );

          const person: Person = {
            companyEmail: draft.companyEmail ?? null,
            departmentId: field.departmentId,
            email: draft.email,
            fieldOfStudyId: draft.fieldOfStudyId,
            id: PersonId.make(yield* nextId(tables)),
            name: draft.name,
          };

          yield* Ref.update(tables.people, (rows) => [...rows, person]);

          return person;
        }),
      findById: (id) => findOrNotFound(tables.people, "Person", id),
      findLocked: (locked) =>
        Effect.orDie(findOrNotFound(tables.people, "Person", locked.id)),
      list: (departmentId) =>
        Effect.map(Ref.get(tables.people), (people) =>
          Arr.sort(
            Arr.filter(
              people,
              (person) =>
                departmentId === null || person.departmentId === departmentId
            ),
            byName<Person>()
          )
        ),
    });
  })
);

const teamRepository = Layer.effect(
  TeamRepository,
  Effect.gen(function* teamRepository() {
    const tables = yield* TeamTables;

    const nameTaken = (team: Team) =>
      Effect.flatMap(Ref.get(tables.teams), (teams) =>
        Arr.some(
          teams,
          (other) =>
            other.id !== team.id &&
            other.departmentId === team.departmentId &&
            other.name === team.name
        )
          ? Effect.fail(
              new AlreadyExists({
                entity: "Team",
                key: team.name,
                message: TEAM_EXISTS,
              })
            )
          : Effect.void
      );

    const groupTaken = (team: Team) =>
      Effect.flatMap(Ref.get(tables.teams), (teams) =>
        team.groupEmail !== null &&
        Arr.some(
          teams,
          (other) =>
            other.id !== team.id && other.groupEmail === team.groupEmail
        )
          ? Effect.fail(
              new AlreadyExists({
                entity: "Team",
                key: team.groupEmail,
                message: "Gruppeadressen er allerede brukt av et annet team.",
              })
            )
          : Effect.void
      );

    const replace = (team: Team) =>
      Ref.update(tables.teams, (rows) =>
        Arr.map(rows, (row) => (row.id === team.id ? team : row))
      );

    return TeamRepository.of({
      create: (draft) =>
        Effect.gen(function* create() {
          const team: Team = {
            ...draft,
            active: true,
            id: TeamId.make(yield* nextId(tables)),
          };

          yield* nameTaken(team);
          yield* groupTaken(team);
          yield* Ref.update(tables.teams, (rows) => [...rows, team]);

          return team;
        }),
      deactivate: (id) =>
        Effect.gen(function* deactivate() {
          const team = {
            ...(yield* findOrNotFound(tables.teams, "Team", id)),
            active: false,
          };

          yield* replace(team);

          return team;
        }),
      findById: (id) => findOrNotFound(tables.teams, "Team", id),
      list: (departmentId) =>
        Effect.map(Ref.get(tables.teams), (teams) =>
          Arr.sort(
            Arr.filter(
              teams,
              (team) =>
                departmentId === null || team.departmentId === departmentId
            ),
            byName<Team>()
          )
        ),
      update: (id, details) =>
        Effect.gen(function* update() {
          const team = {
            ...(yield* findOrNotFound(tables.teams, "Team", id)),
            ...details,
          };

          yield* nameTaken(team);
          yield* groupTaken(team);
          yield* replace(team);

          return team;
        }),
    });
  })
);

const positionRepository = Layer.effect(
  PositionRepository,
  Effect.gen(function* positionRepository() {
    const tables = yield* TeamTables;

    return PositionRepository.of({
      findById: (id) => findOrNotFound(tables.positions, "Position", id),
      list: Effect.map(Ref.get(tables.positions), (positions) =>
        Arr.sort(positions, byName<Position>())
      ),
    });
  })
);

const membershipRepository = Layer.effect(
  MembershipRepository,
  Effect.gen(function* membershipRepository() {
    const tables = yield* TeamTables;

    const view = Effect.fn("view")(function* view(
      memberships: readonly Membership[]
    ): Effect.fn.Return<readonly MembershipView[]> {
      const people = yield* Ref.get(tables.people);
      const positions = yield* Ref.get(tables.positions);

      return Arr.map(memberships, (membership) => ({
        ...membership,
        personName: nameOf(people, membership.personId),
        positionName: nameOf(positions, membership.positionId),
      }));
    });

    return MembershipRepository.of({
      activeIn: (semester) =>
        Effect.gen(function* activeIn() {
          const people = yield* Ref.get(tables.people);
          const positions = yield* Ref.get(tables.positions);
          const teams = yield* Ref.get(tables.teams);

          return Arr.flatMap(
            yield* Ref.get(tables.memberships),
            (membership): readonly ActiveMembership[] => {
              const person = Arr.findFirst(
                people,
                (row) => row.id === membership.personId
              );

              const team = Arr.findFirst(
                teams,
                (row) => row.id === membership.teamId
              );

              return membershipState(membership, semester) === "Active" &&
                Option.isSome(person) &&
                Option.isSome(team)
                ? [
                    {
                      ...membership,
                      departmentId: team.value.departmentId,
                      personEmail: person.value.email,
                      personName: person.value.name,
                      positionName: nameOf(positions, membership.positionId),
                      teamName: team.value.name,
                    },
                  ]
                : [];
            }
          );
        }),
      findById: (id) => findOrNotFound(tables.memberships, "Membership", id),
      findLocked: (locked, id) =>
        Effect.filterOrFail(
          findOrNotFound(tables.memberships, "Membership", id),
          (membership) => membership.personId === locked.id,
          () => new NotFound({ entity: "Membership", key: String(id) })
        ),
      insert: (locked, draft) =>
        Effect.gen(function* insert() {
          const membership: Membership = {
            ...draft,
            id: MembershipId.make(yield* nextId(tables)),
            personId: PersonId.make(locked.id),
          };

          if (overlapping(yield* Ref.get(tables.memberships), membership)) {
            return yield* overlapRefused(membership);
          }

          yield* Ref.update(tables.memberships, (rows) => [
            ...rows,
            membership,
          ]);

          return membership;
        }),
      listByPerson: (personId) =>
        Effect.flatMap(Ref.get(tables.memberships), (rows) =>
          view(
            Arr.sort(
              Arr.filter(rows, (row) => row.personId === personId),
              Order.flip(
                Order.mapInput(Order.Number, (row: Membership) =>
                  semesterOrdinal(row.start)
                )
              )
            )
          )
        ),
      listByTeam: (teamId) =>
        Effect.flatMap(Ref.get(tables.memberships), (rows) =>
          view(
            Arr.sort(
              Arr.filter(rows, (row) => row.teamId === teamId),
              Order.mapInput(Order.Number, (row: Membership) =>
                semesterOrdinal(row.start)
              )
            )
          )
        ),
      listLocked: (locked) =>
        Effect.map(Ref.get(tables.memberships), (rows) =>
          Arr.filter(rows, (row) => row.personId === locked.id)
        ),
      remove: (locked, { current, id, observed }) =>
        Effect.gen(function* remove() {
          const row = Arr.findFirst(
            yield* Ref.get(tables.memberships),
            (membership) =>
              membership.id === id && membership.personId === locked.id
          );

          if (
            Option.isNone(row) ||
            !sameSemester(row.value.start, observed.start) ||
            !sameSemester(row.value.end, observed.end) ||
            membershipState(row.value, current) !== "Planned"
          ) {
            return yield* lostRace(id);
          }

          yield* Ref.update(tables.memberships, (rows) =>
            Arr.filter(rows, (membership) => membership.id !== id)
          );

          return yield* Effect.void;
        }),
      setEnd: (locked, { activeIn, id, newEnd, observedEnd }) =>
        Effect.gen(function* setEnd() {
          const rows = yield* Ref.get(tables.memberships);

          const row = Arr.findFirst(
            rows,
            (membership) =>
              membership.id === id && membership.personId === locked.id
          );

          if (
            Option.isNone(row) ||
            !sameSemester(row.value.end, observedEnd) ||
            membershipState(row.value, activeIn) !== "Active"
          ) {
            return yield* lostRace(id);
          }

          const updated: Membership = { ...row.value, end: newEnd };

          if (overlapping(rows, updated)) {
            return yield* overlapRefused(updated);
          }

          yield* Ref.update(tables.memberships, (all) =>
            Arr.map(all, (membership) =>
              membership.id === id ? updated : membership
            )
          );

          return updated;
        }),
    });
  })
);

const adminGrantRepository = Layer.effect(
  AdminGrantRepository,
  Effect.gen(function* adminGrantRepository() {
    const tables = yield* TeamTables;

    return AdminGrantRepository.of({
      create: (_adminList, locked, draft) =>
        Effect.gen(function* create() {
          const grant: AdminGrant = {
            ...draft,
            id: AdminGrantId.make(yield* nextId(tables)),
            personId: PersonId.make(locked.id),
          };

          yield* Ref.update(tables.adminGrants, (rows) => [...rows, grant]);

          return grant;
        }),
      findById: (id) => findOrNotFound(tables.adminGrants, "AdminGrant", id),
      list: Effect.gen(function* list() {
        const people = yield* Ref.get(tables.people);

        return Arr.sort(
          Arr.map(
            yield* Ref.get(tables.adminGrants),
            (grant): AdminGrantView => ({
              ...grant,
              personName: Option.match(
                Arr.findFirst(people, (person) => person.id === grant.personId),
                { onNone: () => "", onSome: (person) => person.name }
              ),
            })
          ),
          Order.flip(
            Order.mapInput(Order.Number, (grant: AdminGrant) =>
              DateTime.toEpochMillis(grant.until)
            )
          )
        );
      }),
      revoke: (_adminList, locked, id, validAfter) =>
        Effect.gen(function* revoke() {
          const grant = yield* findOrNotFound(
            tables.adminGrants,
            "AdminGrant",
            id
          );

          if (grant.personId !== locked.id) {
            return yield* new NotFound({
              entity: "AdminGrant",
              key: String(id),
            });
          }

          const accounts = yield* Ref.get(tables.accounts);

          // A place counts when it ends after the cut-off and an Active account holds it.
          const counts = (row: AdminGrant) =>
            DateTime.isGreaterThan(row.until, validAfter) &&
            Arr.some(
              accounts,
              (account) =>
                account.personId === row.personId &&
                Predicate.isTagged(account.state, "Active")
            );

          const others = Arr.filter(
            yield* Ref.get(tables.adminGrants),
            (row) => row.id !== id && counts(row)
          );

          if (counts(grant) && others.length === 0) {
            return "last" as const;
          }

          yield* Ref.update(tables.adminGrants, (rows) =>
            Arr.filter(rows, (row) => row.id !== id)
          );

          return "revoked" as const;
        }),
    });
  })
);

/**
 * The locks of the fakes: a person's lock exists when the person does, and the admin list's always does. Nothing
 * waits, because nothing runs at once; the real locking is `packages/db`'s, under test in
 * `test/aggregates.postgres.test.ts`. Each lock is logged (`AdminList:1`, `Person:7`) in the order that it was taken,
 * so a test can see that a command locks the admin list before the person.
 */
const aggregateLocks = Layer.effect(
  AggregateLocks,
  Effect.gen(function* aggregateLocks() {
    const tables = yield* TeamTables;

    const exists = Effect.fnUntraced(function* exists(
      root: AggregateRoot,
      id: number
    ) {
      const people = yield* Ref.get(tables.people);

      return root === "AdminList"
        ? id === ADMIN_LIST_ID
        : Arr.some(people, (person) => person.id === id);
    });

    const lockAll = Effect.fnUntraced(function* lockAll<
      Root extends AggregateRoot,
    >(root: Root, ids: readonly number[]) {
      for (const id of ids) {
        if (!(yield* exists(root, id))) {
          return yield* new NotFound({ entity: root, key: String(id) });
        }
      }

      const wanted = Arr.sort(Arr.dedupe(ids), Order.Number);

      yield* Ref.update(tables.locks, (log) => [
        ...log,
        ...Arr.map(wanted, (id) => `${root}:${id}`),
      ]);

      // SAFETY: the token's brand exists only in its type; the fake has just checked that the rows exist (EX-0025).
      return Arr.map(wanted, (id) =>
        cast<{ id: number; root: Root }, Locked<Root>>({ id, root })
      );
    });

    return AggregateLocks.of({
      lock: (root, id) =>
        Effect.flatMap(lockAll(root, [id]), ([locked]) =>
          locked === undefined
            ? Effect.die("lockAll returned no token")
            : Effect.succeed(locked)
        ),
      lockAll,
    });
  })
);

const digestLedger = Layer.effect(
  DigestLedger,
  Effect.gen(function* digestLedger() {
    const tables = yield* TeamTables;

    return DigestLedger.of({
      claim: (personId, semester) =>
        Ref.modify(tables.digests, (claimed) => {
          const key = `${personId}:${semesterOrdinal(semester)}`;

          return claimed.has(key)
            ? [false, claimed]
            : [true, new Set([...claimed, key])];
        }),
    });
  })
);

const welcomeLedger = Layer.effect(
  WelcomeLedger,
  Effect.gen(function* welcomeLedger() {
    const tables = yield* TeamTables;

    return WelcomeLedger.of({
      claim: (locked) =>
        Ref.modify(tables.welcomes, (claimed) =>
          claimed.has(locked.id)
            ? [false, claimed]
            : [true, new Set([...claimed, locked.id])]
        ),
    });
  })
);

const principalDirectory = Layer.effect(
  PrincipalDirectory,
  Effect.gen(function* principalDirectory() {
    const tables = yield* TeamTables;

    const load = Effect.fnUntraced(function* loadPrincipal(
      matches: (person: Person) => boolean,
      {
        current,
        now,
      }: { readonly current: Semester; readonly now: DateTime.Utc }
    ) {
      const person = Arr.findFirst(yield* Ref.get(tables.people), matches);

      if (Option.isNone(person)) {
        return Option.none();
      }

      const teams = yield* Ref.get(tables.teams);

      const stored = yield* Ref.get(tables.memberships);

      const memberships = Arr.flatMap(
        Arr.filter(
          stored,
          (membership) =>
            membership.personId === person.value.id &&
            membershipState(membership, current) === "Active"
        ),
        (membership: Membership): readonly MembershipFact[] =>
          Option.match(
            Arr.findFirst(teams, (team) => team.id === membership.teamId),
            {
              onNone: () => [],
              onSome: (team) => [
                {
                  departmentId: team.departmentId,
                  function: team.function,
                  leader: membership.leader,
                  teamId: team.id,
                },
              ],
            }
          )
      );

      const grants = yield* Ref.get(tables.adminGrants);

      return Option.some(
        personPrincipal({
          memberships,
          now,
          personId: person.value.id,
          placeEnds: Arr.flatMap(grants, (grant) =>
            grant.personId === person.value.id ? [grant.until] : []
          ),
        })
      );
    });

    return PrincipalDirectory.of({
      activeById: (personId, at) =>
        Effect.gen(function* loadActive() {
          const accounts = yield* Ref.get(tables.accounts);

          if (
            !Arr.some(
              accounts,
              (entry) =>
                entry.personId === personId &&
                Predicate.isTagged(entry.state, "Active")
            )
          ) {
            return Option.none();
          }

          return yield* load((person) => person.id === personId, at);
        }),
      byName: (name, at) => load((person) => person.name === name, at),
      names: (limit) =>
        Effect.map(Ref.get(tables.people), (people) =>
          Arr.take(
            Arr.sort(
              Arr.map(people, (person) => person.name),
              Order.String
            ),
            limit
          )
        ),
    });
  })
);

/** The teams views only read account rows; unimplemented account mutations fail loudly in this test layer. */
const accountReads = Layer.unwrap(
  Effect.map(TeamTables, (tables) =>
    Layer.mock(AccountRepository, { list: Ref.get(tables.accounts) })
  )
);

const teamsRepositories = Layer.mergeAll(
  accountReads,
  aggregateLocks,
  personRepository,
  teamRepository,
  positionRepository,
  membershipRepository,
  adminGrantRepository,
  digestLedger,
  welcomeLedger,
  principalDirectory
);

/** The teams repositories, the digest ledger and the principal directory over one fresh set of `TeamTables`. */
export const TeamsInMemory = teamsRepositories.pipe(
  Layer.provideMerge(TeamTables.layer)
);

/**
 * The same services over `tables` that the caller keeps, so a test that builds its layers once per call still
 * sees one set of rows (`apps/web`'s `memoryLayer`).
 */
export const teamsInMemoryOver = (tables: TeamTableRefs) =>
  teamsRepositories.pipe(Layer.provideMerge(Layer.succeed(TeamTables, tables)));

/** Reads one fake teams table; the tests assert what was (not) written. */
export const teamRows = <A>(select: (tables: Tables) => Ref.Ref<A>) =>
  TeamTables.use((tables) => Ref.get(select(tables)));

/** An Active account for the person: a place on the admin list counts as an Active administrator's only then. */
export const withActiveAccount = (personId: PersonId) =>
  TeamTables.use((tables) =>
    Ref.update(tables.accounts, (rows) => [
      ...rows,
      { personId, state: AccountState.cases.Active.make({}) },
    ])
  );
