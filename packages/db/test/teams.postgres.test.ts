/**
 * The teams domain on real PostgreSQL (spec 0006), each suite on its own disposable database:
 * - falsifier 3: twenty concurrent `extendMembership` and `endEarlyMembership` calls on one membership leave a consistent row, and every
 *   loser gets the typed conflict. The row is consistent when the successes, in the order they committed, replay
 *   as a legal sequence of transitions that ends where the row ends. Since spec 0006b the person's lock keeps that
 *   replay legal on its own, so an unconditional update no longer breaks it: a test asserts that it stays legal.
 * - the lock-removal controls of falsifier 3 (spec 0006b R3): that test and the one that shows an insert waiting for
 *   the person's row lock. Both fail every time `AggregateLocks.lock` stops taking the row lock. The 300-round overlap
 *   races guard the contract with the lock in place; they are not a control, because without the lock they fail only
 *   now and then (spec 0006 R6 saw about 6 rounds in 1,000).
 * - falsifier 4: an overlapping membership and `end < start` are refused by the database itself; dropping the
 *   constraint makes the same insert succeed.
 * - the other races that a constraint or a lock settles: two overlapping inserts, two revocations of the last two
 *   admin places, many claims of one digest.
 */
import { assert, layer } from "@effect/vitest";
import {
  EmailAddress,
  PersonRepository,
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
import { activateAccount } from "./support/accountsWorld.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { meetsHeldLock, race, raceReport } from "./support/race.ts";
import {
  asPerson,
  grantPlace,
  insertMembership,
  lockPerson,
  placeMembership,
  revokePlace,
  semester,
  world,
} from "./support/teamsWorld.ts";

const HOST_2026 = semester("HOST", 2026);

const VAR_2027 = semester("VAR", 2027);

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const LATER = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

const CALLERS = 20;

/** Rounds of the overlap race. Before the person's row lock, about 6 rounds in 1,000 ended in a deadlock. */
const OVERLAP_ROUNDS = 300;

const STRESS_TIMEOUT_MS = 120_000;

/** The database, and the origin that the teams handlers' layer asks for (the links of the digest). */
const teamsDatabase = Layer.merge(
  postgresDatabase(),
  Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
);

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
    ? TeamsEndpoints.extendMembership({ end: target.value, id: membershipId })
    : TeamsEndpoints.endEarlyMembership({
        id: membershipId,
        semester: VAR_2027,
      });

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
                `caller ${index}: endEarlyMembership from Vår 2027 after the end was ${state.end.term} ${state.end.year}`,
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

  const membership = yield* placeMembership(
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

/** How the two overlapping writes of one person differ: two inserts, or an extension of one term and an insert. */
type OverlapMode = "insertAndInsert" | "extendAndInsert";

/** A write whose success value does not matter, with its typed error widened to the tag, so that both kinds of write race together. */
const asWrite = <E extends { readonly _tag: string }, R>(
  write: Effect.Effect<unknown, E, R>
) =>
  Effect.mapError(
    Effect.asVoid(write),
    (failure): { readonly _tag: string } => failure
  );

/**
 * One round of the overlap race, in a world of its own: two writes of one person that overlap, released together.
 * The result lists what is wrong with the outcome, so a failing test prints each loser's full cause (SQLSTATE and
 * the SqlError reason). The contract (spec 0006): exactly one write wins and the other is `AlreadyExists`.
 */
const overlapRound = Effect.fnUntraced(function* overlapRound(
  tag: string,
  mode: OverlapMode
) {
  const { memberPosition, person, team } = yield* world(tag);

  const who = {
    personId: person.id,
    positionId: memberPosition,
    teamId: team.id,
  };

  const earlier =
    mode === "insertAndInsert"
      ? asWrite(
          transactional(
            insertMembership(who, { end: VAR_2027, start: HOST_2026 })
          )
        )
      : asWrite(
          transactional(
            Effect.gen(function* extendOverlapping() {
              const first = yield* insertMembership(who, {
                end: HOST_2026,
                start: HOST_2026,
              });

              const locked = yield* lockPerson(who.personId);

              return yield* MembershipRepository.use((memberships) =>
                memberships.setEnd(locked, {
                  activeIn: HOST_2026,
                  id: first.id,
                  newEnd: VAR_2027,
                  observedEnd: HOST_2026,
                })
              );
            })
          )
        );

  const exits = yield* race([
    earlier,
    asWrite(
      transactional(insertMembership(who, { end: VAR_2027, start: VAR_2027 }))
    ),
  ]);

  const wins = Arr.filter(exits, Exit.isSuccess).length;

  return [
    ...(wins === 1 ? [] : [`${tag}: ${wins} writes succeeded, not one`]),
    ...Arr.flatMap(exits, (exit) =>
      Exit.isSuccess(exit) ||
      Option.exists(
        Exit.findErrorOption(exit),
        Predicate.isTagged("AlreadyExists")
      )
        ? []
        : [
            `${tag}: the loser was not AlreadyExists: ${Cause.pretty(exit.cause)}`,
          ]
    ),
  ];
});

/** `OVERLAP_ROUNDS` rounds, one after the other, each in a world of its own. */
const overlapRounds = Effect.fnUntraced(function* overlapRounds(
  prefix: string,
  mode: OverlapMode
) {
  const problems = yield* Effect.forEach(
    Arr.range(1, OVERLAP_ROUNDS),
    (number) => overlapRound(`${prefix}${number}`, mode),
    { concurrency: 1 }
  );

  return Arr.flatten(problems);
});

/**
 * One round of two revocations at once, in fresh state: each owner is an Active administrator with one valid place,
 * and the two places are revoked together. One succeeds and the other is told it is the last valid place, and one place
 * is left. The owners have Active accounts already: only a place that an Active account holds counts.
 */
const revokeRound = Effect.fnUntraced(function* revokeRound(
  attempt: number,
  owners: readonly [PersonId, PersonId]
) {
  const db = yield* Drizzle;
  const cutoff = DateTime.makeUnsafe("2026-12-31T23:00:00Z");

  yield* db.delete(schema.adminGrant);

  const first = yield* grantPlace(owners[0], { grantedBy: null, until: LATER });

  const second = yield* grantPlace(owners[1], {
    grantedBy: null,
    until: LATER,
  });

  const exits = yield* race([
    revokePlace(owners[0], first.id, cutoff),
    revokePlace(owners[1], second.id, cutoff),
  ]);

  const outcomes = Arr.flatMap(exits, (exit) =>
    Exit.isSuccess(exit) ? [exit.value] : []
  );

  assert.deepStrictEqual(
    Arr.sort(outcomes, Order.String),
    ["last", "revoked"],
    raceReport(attempt, exits)
  );

  assert.strictEqual(
    (yield* db.select().from(schema.adminGrant)).length,
    1,
    raceReport(attempt, exits)
  );
});

layer(teamsDatabase, { excludeTestServices: true })(
  "falsifier 3: concurrent extendMembership and endEarlyMembership on PostgreSQL",
  (outerTest) => {
    outerTest.layer(TestClock.layer())((it) => {
      it.effect(
        "falsifier 3: twenty concurrent extendMembership and endEarlyMembership calls on one membership leave a consistent row, and every loser gets the typed conflict",
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
        "falsifier 3, lock-removal control (spec 0006b R3): the person's lock alone keeps the successes legal, even when the update is unconditional (take the lock away and this fails every time)",
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
                  setEnd: (_locked, { id, newEnd }) =>
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

            assert.deepStrictEqual(
              Arr.map(attempts, (outcome) => outcome.violations),
              Arr.makeBy(6, () => []),
              "the replay finds no illegal sequence: every command decided on the row after the lock, so no write was stale"
            );
          })
      );

      it.effect(
        "two overlapping inserts at once: exactly one wins, the other is refused by the exclusion constraint as AlreadyExists",
        () =>
          Effect.gen(function* effectProgram() {
            assert.deepStrictEqual(
              yield* overlapRound("olap", "insertAndInsert"),
              []
            );
          })
      );

      it.effect(
        `${OVERLAP_ROUNDS} rounds of two overlapping inserts at once: every loser is AlreadyExists, never a deadlock (spec 0006 R6)`,
        () =>
          Effect.gen(function* effectProgram() {
            assert.deepStrictEqual(
              yield* overlapRounds("insert", "insertAndInsert"),
              []
            );
          }),
        STRESS_TIMEOUT_MS
      );

      it.effect(
        `${OVERLAP_ROUNDS} rounds of an extension and an overlapping insert at once: every loser is AlreadyExists, never a deadlock (spec 0006 R6)`,
        () =>
          Effect.gen(function* effectProgram() {
            assert.deepStrictEqual(
              yield* overlapRounds("extend", "extendAndInsert"),
              []
            );
          }),
        STRESS_TIMEOUT_MS
      );

      it.effect(
        "falsifier 3, lock-removal control (spec 0006b R3): an insert waits for the person's row lock before it writes anything, the order that keeps overlapping writes from deadlocking (take the lock away and this fails every time)",
        () =>
          Effect.gen(function* effectProgram() {
            const { memberPosition, person, team } = yield* world("lockwait");
            const db = yield* Drizzle;

            const meeting = yield* meetsHeldLock(
              db
                .select({ id: schema.person.id })
                .from(schema.person)
                .where(eq(schema.person.id, person.id))
                .for("no key update"),
              "%for no key update%",
              transactional(
                insertMembership(
                  {
                    personId: person.id,
                    positionId: memberPosition,
                    teamId: team.id,
                  },
                  { end: VAR_2027, start: HOST_2026 }
                )
              )
            );

            assert.strictEqual(
              meeting.waiting,
              1,
              "the insert was not waiting for the person's row lock"
            );
            assert.isTrue(meeting.stillRunning);

            assert.deepStrictEqual(
              meeting.wrote,
              [],
              "the insert had written to a table before it waited for the lock"
            );

            assert.isFalse(
              meeting.hasTransactionId,
              "the insert had written or row-locked something before it waited for the lock"
            );

            assert.isTrue(Exit.isSuccess(meeting.exit));
          })
      );

      it.effect(
        `${OVERLAP_ROUNDS} rounds of two revocations of a person's last two valid admin places at once: one succeeds and the other is told it is the last`,
        () =>
          Effect.gen(function* effectProgram() {
            const { person } = yield* world("rev");

            yield* asPerson(person.id, activateAccount);

            for (const attempt of Arr.range(1, OVERLAP_ROUNDS)) {
              yield* revokeRound(attempt, [person.id, person.id]);
            }
          }),
        STRESS_TIMEOUT_MS
      );

      it.effect(
        `${OVERLAP_ROUNDS} rounds of two revocations of the last two valid admin places of two different people at once: one succeeds, the other is told it is the last, and the two never deadlock`,
        () =>
          Effect.gen(function* effectProgram() {
            const found = yield* world("rev2");

            const other = yield* PersonRepository.use((people) =>
              transactional(
                people.create({
                  email: EmailAddress.make("rev2.other@example.org"),
                  fieldOfStudyId: found.fieldOfStudy.id,
                  name: "Annen administrator",
                })
              )
            );

            yield* asPerson(found.person.id, activateAccount);
            yield* asPerson(other.id, activateAccount);

            for (const attempt of Arr.range(1, OVERLAP_ROUNDS)) {
              yield* revokeRound(attempt, [found.person.id, other.id]);
            }
          }),
        STRESS_TIMEOUT_MS
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
