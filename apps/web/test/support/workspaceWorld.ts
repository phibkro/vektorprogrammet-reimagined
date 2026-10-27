/**
 * A small real-PostgreSQL world for the Workspace projection tests (spec 0008): one department, `teams` teams, each
 * with `members` active members this semester (HOST 2026) whose Accounts are Active. The first member of each team has
 * a stored company address (`leder<i>@vektorprogrammet.no`); the others have none, so the projection names theirs.
 * Names and addresses are fake. Also the directory and writer fixtures: a deterministic directory, and a writer that
 * applies changes to it as statements of state, so a repeated change changes nothing.
 */
import {
  CompanyEmail,
  WorkspaceDirectory,
  WorkspaceWriteRefused,
  WorkspaceWriter,
} from "@vektorprogrammet/domain";
import type { WorkspaceChange } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Match, Record as Rec, Ref } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

interface Id {
  readonly id: number;
}

/** How big a world to seed. */
export interface WorldSize {
  readonly teams: number;
  readonly members: number;
  /** Whether team `index` (from 1) has a configured group address. */
  readonly configured?: (index: number) => boolean;
}

/** One person of team `team`: `member` counts from 1, and the first one has a stored company address. */
const seedPerson = (
  field: Id,
  team: { readonly id: number; readonly index: number },
  member: number
) =>
  Effect.gen(function* personRows() {
    const sql = yield* SqlClient;

    const [person] = yield* sql<Id>`insert into person ${sql.insert({
      company_email:
        member === 1 ? `leder${team.index}@vektorprogrammet.no` : null,
      email: `p${team.index}x${member}@example.org`,
      email_verified: true,
      field_of_study_id: field.id,
      name: `Medlem${team.index}x${member} Navn`,
    })} returning id`;

    const id = person?.id ?? 0;

    // Høst 2026, the semester that a tick on 2026-10-27 is in; position 2 is `Medlem`, 1 is `Leder`.
    yield* sql`insert into account ${sql.insert({ person_id: id, state: "Active" })}`;
    yield* sql`insert into membership (person_id, team_id, position_id, leader, start_term, start_year, end_term, end_year) values (${id}, ${team.id}, ${member === 1 ? 1 : 2}, ${member === 1}, 'HOST'::semester_term, 2026, 'HOST'::semester_term, 2026)`;
  });

export const seedWorld = (size: WorldSize) =>
  Effect.gen(function* buildWorld() {
    const sql = yield* SqlClient;
    const configured = size.configured ?? (() => true);

    const [department] =
      yield* sql<Id>`insert into department (name, short_name, city, email) values ('Testavdeling', 'TST', 'Testby', 'test@example.org') returning id`;

    const [field] =
      yield* sql<Id>`insert into field_of_study (department_id, name, short_name) values (${department?.id ?? 0}, 'Testlinje', 'TL') returning id`;

    for (const index of Arr.range(1, size.teams)) {
      const groupAddress = configured(index)
        ? `team${index}@vektorprogrammet.no`
        : null;

      const [team] =
        yield* sql<Id>`insert into team (department_id, name, function, default_term, group_email) values (${department?.id ?? 0}, ${`Team ${index}`}, 'other', 1, ${groupAddress}) returning id`;

      yield* Effect.forEach(Arr.range(1, size.members), (member) =>
        seedPerson(field ?? { id: 0 }, { id: team?.id ?? 0, index }, member)
      );
    }
  });

const email = (address: string) => CompanyEmail.make(address);

/** What a fixture directory holds: account addresses, and each group's members. */
export interface DirectoryState {
  readonly accounts: readonly string[];
  readonly groups: Readonly<Record<string, readonly string[]>>;
}

/** A fresh, empty non-production directory. */
export const emptyDirectory = Ref.make<DirectoryState>({
  accounts: [],
  groups: {},
});

/** The directory as a service over a `Ref`, so that a writer fixture can change what the next read sees. */
export const directoryOver = (state: Ref.Ref<DirectoryState>) =>
  Layer.succeed(WorkspaceDirectory)(
    WorkspaceDirectory.of({
      accounts: Effect.map(Ref.get(state), (held) =>
        Arr.map(held.accounts, email)
      ),
      groups: Effect.map(Ref.get(state), (held) =>
        Arr.map(Rec.keys(held.groups), email)
      ),
      members: (group) =>
        Effect.map(Ref.get(state), (held) => {
          const members = held.groups[group];

          return members === undefined ? "missing" : Arr.map(members, email);
        }),
    })
  );

const including = (members: readonly string[], member: string) =>
  members.includes(member) ? members : [...members, member];

/** A change as a statement of state: applying it to a directory in which it already holds changes nothing. */
const applied = (held: DirectoryState, change: WorkspaceChange) =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      EnsureAbsent: ({ group, member }): DirectoryState => ({
        ...held,
        groups: {
          ...held.groups,
          [group]: Arr.filter(
            held.groups[group] ?? [],
            (found) => found !== member
          ),
        },
      }),
      EnsureAccount: ({ address }): DirectoryState => ({
        ...held,
        accounts: including(held.accounts, address),
      }),
      EnsureGroup: ({ address }): DirectoryState => ({
        ...held,
        groups: { ...held.groups, [address]: held.groups[address] ?? [] },
      }),
      EnsureMember: ({ group, member }): DirectoryState => ({
        ...held,
        groups: {
          ...held.groups,
          [group]: including(held.groups[group] ?? [], member),
        },
      }),
    })
  );

/** A writer that applies each change to the directory as a statement of state, and records that it was asked. */
export const writerOver = (
  state: Ref.Ref<DirectoryState>,
  calls: Ref.Ref<readonly WorkspaceChange[]>
) =>
  Layer.succeed(WorkspaceWriter)(
    WorkspaceWriter.of({
      apply: (change) =>
        Ref.update(calls, (asked) => [...asked, change]).pipe(
          Effect.andThen(Ref.update(state, (held) => applied(held, change)))
        ),
    })
  );

/** A writer that refuses everything, as the dry-run mode's does. */
export const refusingWriter = Layer.succeed(WorkspaceWriter)(
  WorkspaceWriter.of({
    apply: () =>
      Effect.fail(new WorkspaceWriteRefused({ reason: "writes are off" })),
  })
);
