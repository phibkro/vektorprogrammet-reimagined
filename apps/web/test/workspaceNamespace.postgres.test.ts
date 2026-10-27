import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  AggregateLocks,
  CompanyEmail,
  DepartmentId,
  EmailAddress,
  FieldOfStudyId,
  PersonRepository,
  TeamId,
  TeamRepository,
  WorkspaceAssignments,
} from "@vektorprogrammet/domain";
import type { DomainError } from "@vektorprogrammet/domain";
import { Array as Arr, Cause, Effect, Exit, Option, Predicate } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Transactor } from "../src/server/transactor";
import { workspaceDatabase } from "./support/workspaceDatabase";
import { seedWorld } from "./support/workspaceWorld";

const live = workspaceDatabase;

interface PersonRow {
  readonly id: number;
  readonly email: string;
  readonly field_of_study_id: number;
  readonly name: string;
}

const group = (address: string) => ({
  defaultTerm: 1 as const,
  function: "other" as const,
  groupEmail: CompanyEmail.make(address),
  name: "Team 1",
});

const profile = (person: PersonRow, address: string | null) => ({
  companyEmail: address === null ? null : EmailAddress.make(address),
  email: EmailAddress.make(person.email),
  fieldOfStudyId: FieldOfStudyId.make(person.field_of_study_id),
  name: person.name,
});

const setProfile = (person: PersonRow, address: string | null) =>
  Effect.gen(function* profileUpdate() {
    const tx = yield* Transactor;
    const locks = yield* AggregateLocks;
    const accounts = yield* AccountRepository;
    yield* tx.run(
      Effect.gen(function* changeProfile() {
        const held = yield* locks.lock("Person", person.id);
        yield* accounts.updateProfile(held, profile(person, address));
      })
    );
  });

interface RaceObservation {
  readonly successes: number;
  readonly failures: readonly Exit.Exit<unknown, unknown>[];
  readonly claims: number | undefined;
  readonly label: string;
}

const observe = <R>(
  left: Effect.Effect<unknown, DomainError, R>,
  right: Effect.Effect<unknown, DomainError, R>,
  address: string,
  label: string
) =>
  Effect.gen(function* raceObservation() {
    const sql = yield* SqlClient;

    const exits = yield* Effect.all([Effect.exit(left), Effect.exit(right)], {
      concurrency: "unbounded",
    });

    const failures = Arr.filter(exits, Exit.isFailure);

    const causes = Arr.join(
      Arr.map(failures, (failure) => Cause.pretty(failure.cause)),
      "\n"
    );

    const [claims] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from company_address where address = ${address}`;

    return {
      claims: claims?.n,
      failures,
      label: `${label}: ${causes}`,
      successes: Arr.filter(exits, Exit.isSuccess).length,
    };
  });

const tagged = (
  observation: RaceObservation,
  tag: "Conflict" | "AlreadyExists"
) =>
  Arr.every(observation.failures, (failure) =>
    Option.exists(Exit.findErrorOption(failure), Predicate.isTagged(tag))
  );

const checks = {
  safe: (observation: RaceObservation) => {
    assert.strictEqual(observation.successes, 1, observation.label);
    assert.strictEqual(observation.failures.length, 1, observation.label);
    assert.isTrue(tagged(observation, "Conflict"), observation.label);
    assert.strictEqual(observation.claims, 1, observation.label);
  },
  "unsafe-profile": (observation: RaceObservation) => {
    assert.strictEqual(observation.failures.length, 1, observation.label);
    assert.isTrue(tagged(observation, "AlreadyExists"), observation.label);
  },
  "unsafe-team": (observation: RaceObservation) => {
    assert.strictEqual(observation.failures.length, 0, observation.label);
    assert.strictEqual(observation.claims, 2, observation.label);
  },
};

layer(live, { excludeTestServices: true })(
  "the shared company address namespace",
  (it) => {
    it.effect(
      "300 fresh races against team and profile edits have one winner and one Conflict; removing the namespace key breaks the control",
      () =>
        Effect.gen(function* namespaceRaces() {
          yield* seedWorld({ members: 3, teams: 1 });
          const sql = yield* SqlClient;

          const rows =
            yield* sql<PersonRow>`select id, email, field_of_study_id, name from person where name in ('Medlem1x2 Navn', 'Medlem1x3 Navn') order by name`;

          const [first, second] = rows;
          assert.isDefined(first);
          assert.isDefined(second);

          if (first === undefined || second === undefined) {
            return yield* Effect.die("the namespace race fixture is missing");
          }

          const [team] = yield* sql<{
            readonly id: number;
          }>`select id from team where name = 'Team 1'`;

          if (team === undefined) {
            return yield* Effect.die("the namespace race team is missing");
          }

          const teamId = TeamId.make(team.id);
          const tx = yield* Transactor;
          const locks = yield* AggregateLocks;
          const assignments = yield* WorkspaceAssignments;

          const teams = yield* TeamRepository;
          const originalGroup = "team1@vektorprogrammet.no";

          const setTeam = (address: string) =>
            tx.run(teams.update(teamId, group(address)));

          const assign = (address: string) =>
            tx.run(
              Effect.gen(function* projectAccount() {
                const held = yield* locks.lock("Person", first.id);
                yield* assignments.assign(held, CompanyEmail.make(address));
              })
            );

          const reset = Effect.gen(function* reset() {
            yield* setProfile(first, null);
            yield* setProfile(second, null);
            yield* setTeam(originalGroup);
          });

          const opponents = {
            profile: (address: string) => setProfile(second, address),
            team: setTeam,
          };

          const checkName = {
            safe: { profile: "safe", team: "safe" },
            unsafe: { profile: "unsafe-profile", team: "unsafe-team" },
          } as const;

          const runRound = (
            kind: "team" | "profile",
            round: number,
            mode: "safe" | "unsafe"
          ) =>
            Effect.gen(function* oneRound() {
              yield* reset;
              const address = `${mode}-${kind}-${round}@vektorprogrammet.no`;

              const observation = yield* observe(
                assign(address),
                opponents[kind](address),
                address,
                `${kind} round ${round}`
              );

              checks[checkName[mode][kind]](observation);
            });

          const runRounds = (
            kind: "team" | "profile",
            mode: "safe" | "unsafe"
          ) =>
            Effect.forEach(
              Arr.range(1, 300),
              (round) => runRound(kind, round, mode),
              { discard: true }
            );

          yield* runRounds("team", "safe");
          yield* runRounds("profile", "safe");
          yield* reset;
          yield* sql`alter table company_address drop constraint company_address_pkey`;
          yield* Effect.gen(function* withoutNamespace() {
            yield* runRounds("team", "unsafe");
            yield* runRounds("profile", "unsafe");
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* restoreNamespace() {
                yield* reset;
                yield* sql`alter table company_address add constraint company_address_pkey primary key (address)`;
              }).pipe(Effect.orDie)
            )
          );

          return yield* Effect.void;
        }),
      { timeout: 120_000 }
    );
    it.effect(
      "300 races of person and team creation against a profile edit do not deadlock or duplicate an address",
      () =>
        Effect.gen(function* creationRaces() {
          const sql = yield* SqlClient;
          yield* sql`truncate membership, account, team, person, field_of_study, department restart identity cascade`;
          yield* seedWorld({ members: 2, teams: 1 });

          const [person] =
            yield* sql<PersonRow>`select id, email, field_of_study_id, name from person where name = 'Medlem1x2 Navn'`;

          const [department] = yield* sql<{
            readonly id: number;
          }>`select id from department`;

          if (person === undefined || department === undefined) {
            return yield* Effect.die("the creation race fixture is missing");
          }

          const tx = yield* Transactor;

          const people = yield* PersonRepository;
          const teams = yield* TeamRepository;

          const updateExisting = (address: string | null) =>
            setProfile(person, address);

          const candidates = {
            person: (address: string, round: number) =>
              tx
                .run(
                  people.create({
                    companyEmail: EmailAddress.make(address),
                    email: EmailAddress.make(`new-person-${round}@example.org`),
                    fieldOfStudyId: FieldOfStudyId.make(
                      person.field_of_study_id
                    ),
                    name: `New person ${round}`,
                  })
                )
                .pipe(Effect.asVoid),
            team: (address: string, round: number) =>
              tx
                .run(
                  teams.create({
                    defaultTerm: 1,
                    departmentId: DepartmentId.make(department.id),
                    function: "other",
                    groupEmail: CompanyEmail.make(address),
                    name: `New team ${round}`,
                  })
                )
                .pipe(Effect.asVoid),
          };

          yield* Effect.forEach(
            ["person", "team"] as const,
            (kind) =>
              Effect.forEach(
                Arr.range(1, 300),
                (round) =>
                  Effect.gen(function* oneCreation() {
                    const address = `creation-${kind}-${round}@vektorprogrammet.no`;

                    checks.safe(
                      yield* observe(
                        candidates[kind](address, round),
                        updateExisting(address),
                        address,
                        `${kind} round ${round}`
                      )
                    );
                    yield* updateExisting(null);
                    yield* sql`delete from person where email = ${`new-person-${round}@example.org`}`;
                    yield* sql`delete from team where name = ${`New team ${round}`}`;
                  }),
                { discard: true }
              ),
            { discard: true }
          );

          return yield* Effect.void;
        }),
      { timeout: 120_000 }
    );
  }
);
