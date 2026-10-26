/**
 * The teams domain on real PostgreSQL (spec 0006), each suite on its own disposable database:
 * - falsifier 3: twenty concurrent `extend` and `endEarly` calls on one membership leave a consistent row, and every
 *   loser gets the typed conflict. The row is consistent when the successes, in the order they committed, replay
 *   as a legal sequence of transitions that ends where the row ends. A negative control swaps the conditional update
 *   for an unconditional one and must break that replay.
 * - falsifier 4: an overlapping membership and `end < start` are refused by the database itself; dropping the
 *   constraint makes the same insert succeed.
 * - the other races that a constraint or a lock settles: two overlapping inserts, two revocations of the last two
 *   admin places, many claims of one digest.
 */
import { assert, layer } from "@effect/vitest";
import {
  AdminGrantRepository,
  SiteOrigin,
  CurrentPrincipal,
  DigestLedger,
  MembershipRepository,
  PersonId,
  Principal,
  TeamsEndpoints,
  advanceSemester,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import type { MembershipId, Semester } from "@vektorprogrammet/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Order,
  Predicate,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  schema,
  transactional,
  violatedUniqueConstraint,
} from "../src/index.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { insertMembership, semester, world } from "./support/teamsWorld.ts";

const HOST_2026 = semester("HOST", 2026);

const VAR_2027 = semester("VAR", 2027);

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const LATER = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

const CALLERS = 20;

/** The database, and the origin that the teams handlers' layer asks for (the links of the digest). */
const teamsDatabase = Layer.merge(
  postgresDatabase(),
  Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
);

/** Runs every effect from its own fiber, released together by one gate, and collects their exits. */
const race = <A, E, R>(
  effects: readonly Effect.Effect<A, E, R>[]
): Effect.Effect<readonly Exit.Exit<A, E>[], never, R> =>
  Effect.gen(function* raceProgram() {
    const gate = yield* Deferred.make<null>();

    const fibers = Effect.forEach(
      effects,
      (effect) => Effect.andThen(Deferred.await(gate), Effect.exit(effect)),
      { concurrency: "unbounded" }
    );

    const [exits] = yield* Effect.all([fibers, Deferred.succeed(gate, null)], {
      concurrency: "unbounded",
    });

    return exits;
  });

/** Caller `index`: an admin, so every command is allowed, with a person id of its own for the audit row. */
const callerNumber = (index: number) => 2000 + index;

const callerOf = (index: number) =>
  Principal.cases.Person.make({
    adminUntil: LATER,
    memberships: [],
    personId: PersonId.make(callerNumber(index)),
  });

/** Even callers extend, to a different later semester each; odd callers end the membership from Vår 2027. */
const extendTarget = (index: number): Option.Option<Semester> =>
  index % 2 === 0
    ? Option.some(advanceSemester(VAR_2027, index / 2 + 1))
    : Option.none();

const callFor = (membershipId: MembershipId, index: number) => {
  const target = extendTarget(index);

  const command = Option.isSome(target)
    ? TeamsEndpoints.extend({ end: target.value, id: membershipId })
    : TeamsEndpoints.endEarly({ id: membershipId, semester: VAR_2027 });

  return transactional(
    Effect.provideService(command, CurrentPrincipal, callerOf(index))
  );
};

/** What a success did, read from the audit rows in the order they were written (the order the row serialised them). */
const written = Effect.fnUntraced(function* written(
  membershipId: MembershipId
) {
  const db = yield* Drizzle;

  const rows = yield* db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.entity, "Membership"),
        eq(schema.auditLog.entityKey, String(membershipId)),
        inArray(schema.auditLog.action, [
          "membership.extended",
          "membership.endedEarly",
        ])
      )
    )
    .orderBy(asc(schema.auditLog.id));

  return Arr.flatMap(rows, (row) =>
    row.personId === null ? [] : [row.personId - 2000]
  );
});

/** Replays the successes as transitions of the term that began as Høst 2026 to Vår 2027: every step must have been legal. */
interface Replayed {
  readonly end: Semester;
  readonly violations: readonly string[];
}

const replay = (callers: readonly number[]) =>
  Arr.reduce<number, Replayed>(
    callers,
    { end: VAR_2027, violations: [] },
    (state, index) => {
      const target = extendTarget(index);

      if (Option.isSome(target)) {
        return {
          end: target.value,
          violations:
            semesterOrdinal(target.value) > semesterOrdinal(state.end)
              ? state.violations
              : [
                  ...state.violations,
                  `caller ${index}: extend to ${target.value.term} ${target.value.year} from a later end`,
                ],
        };
      }

      return {
        end: HOST_2026,
        violations:
          semesterOrdinal(VAR_2027) > semesterOrdinal(HOST_2026) &&
          semesterOrdinal(VAR_2027) <= semesterOrdinal(state.end)
            ? state.violations
            : [
                ...state.violations,
                `caller ${index}: endEarly from Vår 2027 after the end was ${state.end.term} ${state.end.year}`,
              ],
      };
    }
  );

const conflictOrSuccess = (
  exit: Exit.Exit<unknown, { readonly _tag: string }>
) =>
  Exit.isSuccess(exit) ||
  (Exit.isFailure(exit) &&
    Option.exists(Exit.findErrorOption(exit), Predicate.isTagged("Conflict")));

/** One membership of Ola from Høst 2026 to Vår 2027 in a world of its own. */
const freshMembership = Effect.fnUntraced(function* freshMembership(
  tag: string
) {
  const found = yield* world(tag);

  const membership = yield* insertMembership(
    {
      personId: found.person.id,
      positionId: found.memberPosition,
      teamId: found.team.id,
    },
    { end: VAR_2027, start: HOST_2026 }
  );

  return { ...found, membership };
});

/** One round of the race: the membership, twenty callers, and what the row and the audit trail say after. */
const round = Effect.fnUntraced(function* round(tag: string) {
  const { membership } = yield* freshMembership(tag);

  const exits = yield* race(
    Arr.makeBy(CALLERS, (index) => callFor(membership.id, index))
  );

  const db = yield* Drizzle;

  const [row] = yield* db
    .select()
    .from(schema.membership)
    .where(eq(schema.membership.id, membership.id));

  const succeeded = yield* written(membership.id);
  const { end, violations } = replay(succeeded);

  return {
    end,
    exits,
    finalEnd:
      row === undefined ? undefined : { term: row.endTerm, year: row.endYear },
    succeeded,
    violations,
  };
});

layer(teamsDatabase, { excludeTestServices: true })(
  "falsifier 3: concurrent extend and endEarly on PostgreSQL",
  (outerTest) => {
    outerTest.layer(TestClock.layer())((it) => {
      it.effect(
        "falsifier 3: twenty concurrent extend and endEarly calls on one membership leave a consistent row, and every loser gets the typed conflict",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NOW));

            const outcomes = yield* Effect.forEach(Arr.range(1, 3), (index) =>
              round(`ok${index}`)
            );

            for (const outcome of outcomes) {
              assert.isTrue(
                Arr.every(outcome.exits, conflictOrSuccess),
                "every call succeeds or is refused with a Conflict, never a defect"
              );
              assert.isAbove(outcome.succeeded.length, 0);
              assert.strictEqual(
                outcome.succeeded.length,
                Arr.length(Arr.filter(outcome.exits, Exit.isSuccess))
              );
              assert.deepStrictEqual(outcome.violations, []);
              assert.deepStrictEqual(outcome.finalEnd, outcome.end);
            }

            const losers = Arr.flatMap(outcomes, (outcome) =>
              Arr.filter(outcome.exits, Exit.isFailure)
            );

            assert.isAbove(
              losers.length,
              0,
              "twenty callers at once do lose races: the conflicts are real"
            );
          })
      );

      it.effect(
        "falsifier 3, negative control: with an unconditional update instead of the conditional one, the successes no longer replay as legal transitions",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(NOW));

            const unconditional = Layer.effect(
              MembershipRepository,
              Effect.gen(function* unconditional() {
                const live = yield* MembershipRepository;
                const sql = yield* SqlClient;

                return MembershipRepository.of({
                  ...live,
                  setEnd: ({ id, newEnd }) =>
                    Effect.orDie(
                      Effect.andThen(
                        sql`update membership set end_term = ${newEnd.term}, end_year = ${newEnd.year} where id = ${id}`,
                        live.findById(id)
                      )
                    ),
                });
              })
            );

            const attempts = yield* Effect.forEach(Arr.range(1, 6), (index) =>
              Effect.provide(round(`bad${index}`), unconditional)
            );

            assert.isTrue(
              Arr.some(attempts, (outcome) => outcome.violations.length > 0),
              "the replay finds an illegal sequence once the update is unconditional"
            );
          })
      );

      it.effect(
        "two overlapping inserts at once: exactly one wins, the other is refused by the exclusion constraint as AlreadyExists",
        () =>
          Effect.gen(function* effectProgram() {
            const { memberPosition, person, team } = yield* world("olap");

            const who = {
              personId: person.id,
              positionId: memberPosition,
              teamId: team.id,
            };

            const exits = yield* race([
              transactional(
                insertMembership(who, { end: VAR_2027, start: HOST_2026 })
              ),
              transactional(
                insertMembership(who, { end: VAR_2027, start: VAR_2027 })
              ),
            ]);

            assert.strictEqual(Arr.filter(exits, Exit.isSuccess).length, 1);

            const loser = Arr.findFirst(exits, Exit.isFailure);

            assert.isTrue(
              Option.exists(
                Option.flatMap(loser, Exit.findErrorOption),
                Predicate.isTagged("AlreadyExists")
              )
            );
          })
      );

      it.effect(
        "two revocations of the last two valid admin places at once: one succeeds and the other is told it is the last",
        () =>
          Effect.gen(function* effectProgram() {
            const { person } = yield* world("rev");
            const grants = yield* AdminGrantRepository;
            const db = yield* Drizzle;
            const cutoff = DateTime.makeUnsafe("2026-12-31T23:00:00Z");

            for (const _ of Arr.range(1, 8)) {
              yield* db.delete(schema.adminGrant);

              const first = yield* grants.create({
                grantedBy: null,
                personId: person.id,
                until: LATER,
              });

              const second = yield* grants.create({
                grantedBy: null,
                personId: person.id,
                until: LATER,
              });

              const exits = yield* race([
                transactional(grants.revoke(first.id, cutoff)),
                transactional(grants.revoke(second.id, cutoff)),
              ]);

              const outcomes = Arr.flatMap(exits, (exit) =>
                Exit.isSuccess(exit) ? [exit.value] : []
              );

              assert.deepStrictEqual(Arr.sort(outcomes, Order.String), [
                "last",
                "revoked",
              ]);
              assert.strictEqual(
                (yield* db.select().from(schema.adminGrant)).length,
                1
              );
            }
          })
      );

      it.effect(
        "many claims of one leader's digest at once: exactly one is told it is the first",
        () =>
          Effect.gen(function* effectProgram() {
            const { person } = yield* world("led");
            const ledger = yield* DigestLedger;

            const exits = yield* race(
              Arr.makeBy(10, () =>
                transactional(ledger.claim(person.id, HOST_2026))
              )
            );

            const firsts = Arr.filter(
              Arr.flatMap(exits, (exit) =>
                Exit.isSuccess(exit) ? [exit.value] : []
              ),
              Predicate.isTruthy
            );

            assert.strictEqual(firsts.length, 1);
          })
      );
    });
  }
);

const insertInto = (
  personId: number,
  teamId: number,
  positionId: number,
  term: { readonly start: Semester; readonly end: Semester }
) =>
  Effect.gen(function* insertRow() {
    const sql = yield* SqlClient;

    yield* sql`insert into membership (person_id, team_id, position_id, start_term, start_year, end_term, end_year)
      values (${personId}, ${teamId}, ${positionId}, ${term.start.term}, ${term.start.year}, ${term.end.term}, ${term.end.year})`;
  });

const constraintOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? violatedUniqueConstraint(Cause.squash(exit.cause))
    : Option.none();

layer(postgresDatabase(), { excludeTestServices: true })(
  "falsifier 4: the constraints hold in the database",
  (it) => {
    it.effect(
      "falsifier 4: an overlapping membership is refused by the database, and dropping the constraint lets it in",
      () =>
        Effect.gen(function* effectProgram() {
          const sql = yield* SqlClient;
          const { memberPosition, person, team } = yield* world("nooverlap");

          const insert = (term: { start: Semester; end: Semester }) =>
            insertInto(person.id, team.id, memberPosition, term);

          yield* insert({ end: VAR_2027, start: HOST_2026 });

          const refused = yield* Effect.exit(
            insert({ end: semester("HOST", 2027), start: VAR_2027 })
          );

          assert.deepStrictEqual(
            constraintOf(refused),
            Option.some("membership_no_overlap")
          );

          const adjacent = yield* Effect.exit(
            insert({
              end: semester("HOST", 2027),
              start: semester("HOST", 2027),
            })
          );

          assert.isTrue(Exit.isSuccess(adjacent));

          yield* sql`alter table membership drop constraint membership_no_overlap`;

          const afterDrop = yield* Effect.exit(
            insert({ end: semester("HOST", 2027), start: VAR_2027 })
          );

          assert.isTrue(
            Exit.isSuccess(afterDrop),
            "without the constraint the overlapping insert succeeds, so the refusal above came from it"
          );
        })
    );

    it.effect(
      "falsifier 4: a membership that ends before it starts is refused by the database, and dropping the check lets it in",
      () =>
        Effect.gen(function* effectProgram() {
          const sql = yield* SqlClient;
          const { memberPosition, person, team } = yield* world("backwards");

          const backwards = {
            end: HOST_2026,
            start: semester("HOST", 2027),
          };

          const refused = yield* Effect.exit(
            insertInto(person.id, team.id, memberPosition, backwards)
          );

          assert.isTrue(Exit.isFailure(refused));
          assert.include(
            Cause.pretty(Exit.isFailure(refused) ? refused.cause : Cause.empty),
            "membership_term_order"
          );

          yield* sql`alter table membership drop constraint membership_term_order`;

          const afterDrop = yield* Effect.exit(
            insertInto(person.id, team.id, memberPosition, backwards)
          );

          assert.isTrue(
            Exit.isSuccess(afterDrop),
            "without the check the backwards term is stored, so the refusal above came from it"
          );
        })
    );

    it.effect(
      "an audit row names a person or a job, never both and never neither",
      () =>
        Effect.gen(function* effectProgram() {
          const sql = yield* SqlClient;

          const insert = (personId: number | null, job: string | null) =>
            Effect.exit(
              sql`insert into audit_log (action, at, entity, entity_key, person_id, system_job)
                values ('team.created', now(), 'Team', '1', ${personId}, ${job})`
            );

          const outcomes = yield* Effect.all([
            insert(7, null),
            insert(null, "endingSoon"),
            insert(7, "endingSoon"),
            insert(null, null),
            insert(null, "somethingElse"),
          ]);

          assert.deepStrictEqual(Arr.map(outcomes, Exit.isSuccess), [
            true,
            true,
            false,
            false,
            false,
          ]);
        })
    );
  }
);
