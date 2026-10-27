/**
 * The PostgreSQL behaviour that the model of `.agents/skills/verify-membership-writes` assumes, each claim shown on
 * real PostgreSQL (devenv) in a disposable database. The model (`model/MembershipWrites.tla`) runs the statements of
 * the code against rules that PostgreSQL, not this code, defines: how an exclusion constraint is checked, what a row
 * lock waits for, in which order `SELECT … ORDER BY id FOR NO KEY UPDATE` takes its rows, what the deadlock detector
 * does. A model of those rules is worth what the rules are worth, so each one is pinned here, and a PostgreSQL release
 * that changes one fails this file instead of leaving the model true to a database that no longer exists. Every test
 * names the model action it stands behind. The last block runs the real commands: each takes the person's lock before
 * it writes (`compose` in `model/Shapes.tla`).
 *
 * A session is one transaction on its own connection, driven statement by statement. A statement that has to wait for
 * another session does not block the test: the test asks PostgreSQL who is blocked (`pg_blocking_pids`) and only then
 * lets the other session end.
 */
import { assert, layer } from "@effect/vitest";
import {
  AggregateLocks,
  CurrentPrincipal,
  PersonId,
  Principal,
  SiteOrigin,
  TeamsEndpoints,
  advanceSemester,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import type {
  MembershipId,
  PositionId,
  Semester,
  TeamId,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Order,
  Predicate,
  Queue,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { lockableElsewhere, meetsHeldLock } from "./support/race.ts";
import { placeMembership, semester, world } from "./support/teamsWorld.ts";

type Statement = Effect.Effect<unknown, SqlError, SqlClient>;

type Ending = "commit" | "rollback";

/** Semester number `n` after Vår 3000, so that every term below is a small number. */
const at = (n: number): Semester =>
  advanceSemester({ term: "VAR", year: 3000 }, n);

interface Who {
  readonly personId: PersonId;
  readonly positionId: PositionId;
  readonly teamId: TeamId;
}

/** `SELECT ... FOR NO KEY UPDATE` on the person's row: the statement of `AggregateLocks.lock`, as raw SQL for a session. */
const lockPerson = (personId: PersonId): Statement =>
  Effect.gen(function* lockPersonStatement() {
    const sql = yield* SqlClient;

    return yield* sql`select id from person where id = ${personId} for no key update`;
  });

/** The INSERT of `MembershipRepository.insert`, without its lock: what PostgreSQL does with the row and its entry. */
const insertTerm = (who: Who, start: number, end: number): Statement =>
  Effect.gen(function* insertStatement() {
    const sql = yield* SqlClient;

    return yield* sql`insert into membership (person_id, team_id, position_id, start_term, start_year, end_term, end_year)
      values (${who.personId}, ${who.teamId}, ${who.positionId}, ${at(start).term}, ${at(start).year}, ${at(end).term}, ${at(end).year})
      returning id`;
  });

/** The UPDATE of `MembershipRepository.setEnd`: the end moves only if it is still the one that the caller read. */
const moveEnd = (
  id: MembershipId,
  newEnd: number,
  observedEnd: number,
  current: number
): Statement =>
  Effect.gen(function* updateStatement() {
    const sql = yield* SqlClient;

    return yield* sql`update membership set end_term = ${at(newEnd).term}, end_year = ${at(newEnd).year}
      where id = ${id} and end_ordinal = ${semesterOrdinal(at(observedEnd))}
        and start_ordinal <= ${semesterOrdinal(at(current))} and end_ordinal >= ${semesterOrdinal(at(current))}
      returning id`;
  });

const deleteRow = (id: MembershipId): Statement =>
  Effect.gen(function* deleteStatement() {
    const sql = yield* SqlClient;

    return yield* sql`delete from membership where id = ${id} returning id`;
  });

/** The SQLSTATE that the driver reports in a failed statement (`23P01`, `40P01`). */
const driverCode = (failure: SqlError): Option.Option<string> => {
  const { cause } = failure.reason;

  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
    ? Option.some(cause.code)
    : Option.none();
};

/** What a statement ended as: `ok`, the SQLSTATE of its failure, or `defect`. */
const sqlstateOf = (exit: Exit.Exit<unknown, SqlError>): string =>
  Exit.isSuccess(exit)
    ? "ok"
    : Option.getOrElse(
        Option.flatMap(Cause.findErrorOption(exit.cause), driverCode),
        () => "defect"
      );

const rowCountOf = (exit: Exit.Exit<unknown, SqlError>): number =>
  Exit.isSuccess(exit) && Arr.isArray(exit.value) ? exit.value.length : -1;

/** What a session runs next; `false` ends it. */
type Step = Effect.Effect<boolean, never, SqlClient>;

interface Session {
  /** The session ends: its transaction commits or rolls back. */
  readonly end: (how: Ending) => Effect.Effect<void>;
  readonly fiber: Fiber.Fiber<Exit.Exit<void>>;
  /** The statement starts in the session's transaction at once; the result arrives when PostgreSQL answers. */
  readonly start: (
    statement: Statement
  ) => Effect.Effect<Deferred.Deferred<Exit.Exit<unknown, SqlError>>>;
}

/** One transaction, on its own connection, that runs the statements it is given until it is told to end. */
const session = Effect.fnUntraced(function* session() {
  const steps = yield* Queue.unbounded<Step>();

  const serve: Effect.Effect<void, never, SqlClient> = Effect.flatMap(
    Queue.take(steps),
    (step) => Effect.flatMap(step, (more) => (more ? serve : Effect.void))
  );

  const fiber = yield* Effect.forkChild(Effect.exit(transactional(serve)));

  return {
    // A rollback is a defect in the session's program: a typed failure or a defect rolls the transaction back.
    end: (how: Ending) =>
      Queue.offer(
        steps,
        how === "commit"
          ? Effect.succeed(false)
          : Effect.die("the test rolls this session back")
      ),
    fiber,
    start: (statement: Statement) =>
      Effect.gen(function* startStatement() {
        const result = yield* Deferred.make<Exit.Exit<unknown, SqlError>>();

        yield* Queue.offer(
          steps,
          Effect.flatMap(Effect.exit(statement), (exit) =>
            Effect.as(Deferred.succeed(result, exit), true)
          )
        );

        return result;
      }),
  } satisfies Session;
});

/** How many sessions of this database wait for another one right now. */
const blockedSessions = Effect.gen(function* blockedSessions() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly blocked: number;
  }>`select count(*)::int as blocked from pg_stat_activity
    where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`;

  return rows[0]?.blocked ?? 0;
});

/** True once PostgreSQL shows `wanted` sessions waiting, false when none shows up within five seconds. */
const untilBlocked = Effect.fnUntraced(function* untilBlocked(wanted: number) {
  for (const _ of Arr.range(1, 500)) {
    if ((yield* blockedSessions) >= wanted) {
      return true;
    }

    yield* Effect.sleep("10 millis");
  }

  return false;
});

const fresh = Effect.fnUntraced(function* fresh(tag: string) {
  const found = yield* world(tag);

  return {
    personId: found.person.id,
    positionId: found.memberPosition,
    teamId: found.team.id,
  } satisfies Who;
});

/**
 * Session 1 runs `first` and stays open. Session 2 runs `second`, which has to wait for it. Session 1 then ends as
 * `firstEnds` says. The result is how `second` ended, and whether PostgreSQL showed it waiting before that.
 */
const waitsForTheFirst = Effect.fnUntraced(function* waitsForTheFirst(
  first: Statement,
  second: Statement,
  firstEnds: Ending
) {
  const one = yield* session();
  const two = yield* session();
  yield* Deferred.await(yield* one.start(first));

  const answer = yield* two.start(second);
  const waited = yield* untilBlocked(1);
  const stillWaiting = !(yield* Deferred.isDone(answer));

  yield* one.end(firstEnds);
  const exit = yield* Deferred.await(answer);
  yield* two.end("rollback");
  yield* Fiber.join(one.fiber);
  yield* Fiber.join(two.fiber);

  return { exit, waited: waited && stillWaiting };
});

/**
 * Each session holds something that the other one then asks for: a cycle of waits. PostgreSQL finds it after
 * `deadlock_timeout` and rolls one of the two back with 40P01; the other goes on. The result is how the two wanting
 * statements ended, sorted.
 */
const crosswise = Effect.fnUntraced(function* crosswise(options: {
  readonly firstHolds: Statement;
  readonly secondHolds: Statement;
  readonly firstWants: Statement;
  readonly secondWants: Statement;
}) {
  const one = yield* session();
  const two = yield* session();
  yield* Deferred.await(yield* one.start(options.firstHolds));
  yield* Deferred.await(yield* two.start(options.secondHolds));

  const firstAnswer = yield* one.start(options.firstWants);
  yield* untilBlocked(1);
  const secondAnswer = yield* two.start(options.secondWants);

  const results = [
    sqlstateOf(yield* Deferred.await(firstAnswer)),
    sqlstateOf(yield* Deferred.await(secondAnswer)),
  ];

  yield* one.end("rollback");
  yield* two.end("rollback");
  yield* Fiber.join(one.fiber);
  yield* Fiber.join(two.fiber);

  return Arr.sort(results, Order.String);
});

layer(postgresDatabase(), { excludeTestServices: true })(
  "PostgreSQL behaviour that the membership-write model assumes",
  (it) => {
    // ------------------------------------------------ the exclusion constraint (CheckWait, CheckRefuse, CheckPass)

    for (const ending of ["commit", "rollback"] as const) {
      const refusedAfterCommit = ending === "commit" ? "23P01" : "ok";
      const acceptedAfterCommit = ending === "commit" ? "ok" : "23P01";

      it.effect(
        `INSERT overlapping an unfinished INSERT waits for it; after its ${ending} it ends as ${refusedAfterCommit}`,
        () =>
          Effect.gen(function* effectProgram() {
            const who = yield* fresh(`ins${ending}`);

            const result = yield* waitsForTheFirst(
              insertTerm(who, 10, 11),
              insertTerm(who, 11, 12),
              ending
            );

            assert.isTrue(result.waited);
            assert.strictEqual(sqlstateOf(result.exit), refusedAfterCommit);
          })
      );

      it.effect(
        `INSERT overlapping a row that an unfinished transaction deleted waits for it; after its ${ending} it ends as ${acceptedAfterCommit}`,
        () =>
          Effect.gen(function* effectProgram() {
            const who = yield* fresh(`del${ending}`);

            const base = yield* placeMembership(who, {
              end: at(21),
              start: at(20),
            });

            const result = yield* waitsForTheFirst(
              deleteRow(base.id),
              insertTerm(who, 21, 22),
              ending
            );

            assert.isTrue(result.waited);
            assert.strictEqual(sqlstateOf(result.exit), acceptedAfterCommit);
          })
      );

      it.effect(
        `an UPDATE that moves a term is checked like an INSERT: it waits for an unfinished overlapping INSERT, and after its ${ending} ends as ${refusedAfterCommit}`,
        () =>
          Effect.gen(function* effectProgram() {
            const who = yield* fresh(`upd${ending}`);

            const base = yield* placeMembership(who, {
              end: at(31),
              start: at(30),
            });

            const result = yield* waitsForTheFirst(
              insertTerm(who, 33, 33),
              moveEnd(base.id, 33, 31, 31),
              ending
            );

            assert.isTrue(result.waited);
            assert.strictEqual(sqlstateOf(result.exit), refusedAfterCommit);
          })
      );
    }

    it.effect(
      "two writes that each wait for the other's unfinished row are a deadlock: PostgreSQL rolls back exactly one with 40P01",
      () =>
        Effect.gen(function* effectProgram() {
          const who = yield* fresh("cross");

          // Session 1 wrote [40, 41] and session 2 wrote [42, 43]. Session 2 now writes [41, 41] and session 1
          // writes [42, 42]: each overlaps the other's unfinished row, so each waits for the other.
          const results = yield* crosswise({
            firstHolds: insertTerm(who, 40, 41),
            firstWants: insertTerm(who, 42, 42),
            secondHolds: insertTerm(who, 42, 43),
            secondWants: insertTerm(who, 41, 41),
          });

          // The victim's rows die with it, so the survivor's write no longer overlaps anything.
          assert.deepStrictEqual(results, ["40P01", "ok"]);
        })
    );

    // ------------------------------------------------ the person's row lock (LockPerson)

    it.effect(
      "FOR NO KEY UPDATE on the person: a second one waits, an INSERT's foreign-key check does not (FOR UPDATE would block it)",
      () =>
        Effect.gen(function* effectProgram() {
          const who = yield* fresh("lock");
          const other = yield* fresh("lockother");
          const sql = yield* SqlClient;

          const holder = yield* session();
          yield* Deferred.await(yield* holder.start(lockPerson(who.personId)));

          const writer = yield* session();
          const inserted = yield* writer.start(insertTerm(who, 50, 51));

          assert.strictEqual(
            sqlstateOf(yield* Deferred.await(inserted)),
            "ok",
            "the foreign-key check does not conflict with FOR NO KEY UPDATE"
          );

          const locker = yield* session();
          const locked = yield* locker.start(lockPerson(who.personId));
          assert.isTrue(
            yield* untilBlocked(1),
            "a second FOR NO KEY UPDATE waits"
          );
          assert.isFalse(yield* Deferred.isDone(locked));

          yield* holder.end("commit");
          assert.strictEqual(sqlstateOf(yield* Deferred.await(locked)), "ok");

          // The contrast that "no foreign-key check conflicts with it" rests on.
          const exclusive = yield* session();

          yield* Deferred.await(
            yield* exclusive.start(
              sql`select id from person where id = ${other.personId} for update`
            )
          );

          const checked = yield* writer.start(insertTerm(other, 52, 53));
          assert.isTrue(
            yield* untilBlocked(1),
            "FOR UPDATE blocks the foreign-key check"
          );
          yield* exclusive.end("commit");
          assert.strictEqual(sqlstateOf(yield* Deferred.await(checked)), "ok");

          yield* locker.end("rollback");
          yield* writer.end("rollback");
          yield* Effect.forEach([holder, exclusive, locker, writer], (done) =>
            Fiber.join(done.fiber)
          );
        })
    );

    // ------------------------------------------------ the conditional UPDATE (UpdateEnd)

    for (const ending of ["commit", "rollback"] as const) {
      it.effect(
        `a conditional UPDATE waits for the row's unfinished writer; after its ${ending} it changes ${ending === "commit" ? "no row, because the end is no longer the observed one" : "one row"}`,
        () =>
          Effect.gen(function* effectProgram() {
            const who = yield* fresh(`cond${ending}`);

            const base = yield* placeMembership(who, {
              end: at(61),
              start: at(60),
            });

            const result = yield* waitsForTheFirst(
              moveEnd(base.id, 62, 61, 61),
              moveEnd(base.id, 61, 61, 61),
              ending
            );

            assert.isTrue(result.waited);
            assert.strictEqual(
              rowCountOf(result.exit),
              ending === "commit" ? 0 : 1
            );
          })
      );
    }

    // ------------------------------------------------ what the lock order must prevent (WhatIf, Pair)

    it.effect(
      "a DELETE before the lock, against a lock before an INSERT that overlaps the deleted row, is a deadlock (the `replace` what-if)",
      () =>
        Effect.gen(function* effectProgram() {
          const who = yield* fresh("replace");

          const planned = yield* placeMembership(who, {
            end: at(91),
            start: at(91),
          });

          // Session 1 deleted the planned membership and has not taken the lock. Session 2 holds the lock and
          // writes a term over the deleted row, so it waits for session 1. Now session 1 asks for the lock.
          const results = yield* crosswise({
            firstHolds: deleteRow(planned.id),
            firstWants: lockPerson(who.personId),
            secondHolds: lockPerson(who.personId),
            secondWants: insertTerm(who, 91, 92),
          });

          // Which one is the victim is up to PostgreSQL. If session 1 is, its DELETE is undone, the planned row is
          // alive again, and session 2's write meets it (23P01); if session 2 is, session 1 gets the lock (ok).
          assert.strictEqual(
            Arr.filter(results, (result) => result === "40P01").length,
            1
          );
          assert.isTrue(
            Arr.some(results, (result) => result === "ok" || result === "23P01")
          );
        })
    );

    it.effect(
      "two commands that lock two persons in opposite orders are a deadlock (spec 0006b locks in id order for this reason)",
      () =>
        Effect.gen(function* effectProgram() {
          const first = yield* fresh("pairone");
          const second = yield* fresh("pairtwo");

          const results = yield* crosswise({
            firstHolds: lockPerson(first.personId),
            firstWants: lockPerson(second.personId),
            secondHolds: lockPerson(second.personId),
            secondWants: lockPerson(first.personId),
          });

          assert.deepStrictEqual(results, ["40P01", "ok"]);
        })
    );

    // ------------------------------------------------ the platform

    it.effect(
      "a command's transaction is READ COMMITTED, the isolation level that the model has",
      () =>
        Effect.gen(function* effectProgram() {
          const rows = yield* transactional(
            Effect.gen(function* isolationLevel() {
              const sql = yield* SqlClient;

              return yield* sql<{
                readonly level: string;
              }>`select current_setting('transaction_isolation') as level`;
            })
          );

          assert.strictEqual(rows[0]?.level, "read committed");
        })
    );

    // ------------------------------------------------ the lock construct (Shapes.tla `repo.lock`, Pair `LockAll`)

    it.effect(
      "lockAll is one statement ordered by id that takes its rows lowest first, one at a time: asked for [high, low] it holds the low row while it waits for the high one, and nothing of the high row while it waits for the low one",
      () =>
        Effect.gen(function* effectProgram() {
          const low = (yield* fresh("lockalllow")).personId;
          const between = (yield* fresh("lockallmid")).personId;
          const high = (yield* fresh("lockallhigh")).personId;

          const lockAll = transactional(
            AggregateLocks.use((locks) => locks.lockAll("Person", [high, low]))
          );

          // Another session holds the high row: the statement has locked the low row and waits for this one.
          const waitingForHigh = yield* meetsHeldLock(
            lockPerson(high),
            "%order by%for no key update%",
            lockAll,
            Effect.all({
              between: lockableElsewhere(between),
              low: lockableElsewhere(low),
            })
          );

          assert.strictEqual(
            waitingForHigh.waiting,
            1,
            "lockAll's statement is ordered by id, and it waits for a row that another session holds"
          );

          assert.deepStrictEqual(
            waitingForHigh.during,
            { between: true, low: false },
            "it holds the low row while it waits, and a row that is not in its list is free"
          );

          // Another session holds the low row: the statement waits for it before it takes the high one.
          const waitingForLow = yield* meetsHeldLock(
            lockPerson(low),
            "%order by%for no key update%",
            lockAll,
            Effect.all({
              high: lockableElsewhere(high),
              low: lockableElsewhere(low),
            })
          );

          assert.strictEqual(waitingForLow.waiting, 1);

          assert.deepStrictEqual(
            waitingForLow.during,
            { high: true, low: false },
            "the high row is free while the statement waits for the low one"
          );

          for (const meeting of [waitingForHigh, waitingForLow]) {
            assert.deepStrictEqual(
              Exit.isSuccess(meeting.exit)
                ? Arr.map(meeting.exit.value, (token) => token.id)
                : [],
              [low, high],
              "the tokens come back in ascending id order"
            );
          }
        })
    );
  }
);

// ---------------------------------------------------- the commands (Shapes.tla `compose`)

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const LATER = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

const HOST_2026 = semester("HOST", 2026);

const VAR_2027 = semester("VAR", 2027);

/** The database, and the origin that the teams handlers' layer asks for (the links of the digest). */
const teamsDatabase = Layer.merge(
  postgresDatabase(),
  Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
);

/** An administrator, so that every command is allowed. */
const admin = Principal.cases.Person.make({
  adminUntil: LATER,
  memberships: [],
  personId: PersonId.make(9001),
});

/** The person's memberships as the table has them: what a command that wrote something would change. */
const membershipsOf = (personId: PersonId) =>
  Effect.flatMap(
    SqlClient,
    (sql) =>
      sql<{
        readonly id: number;
        readonly end_ordinal: number;
        readonly start_ordinal: number;
        readonly team_id: number;
      }>`select id, team_id, start_ordinal, end_ordinal from membership where person_id = ${personId} order by id`
  );

/**
 * Runs `command` as an administrator while another session holds the person's row lock, and shows what `compose` in
 * `Shapes.tla` says of it: PostgreSQL shows the command waiting on a lock, and the waiting backend has written nothing
 * by then (no table that it holds a write lock on, and no transaction id, which its first write or row lock would give
 * it). Once the lock is let go the command succeeds and writes a membership.
 */
const waitsForThePersonsLock = Effect.fnUntraced(
  function* waitsForThePersonsLock<A, E, R>(
    name: string,
    who: Who,
    command: Effect.Effect<A, E, R>
  ) {
    const before = yield* membershipsOf(who.personId);

    const meeting = yield* meetsHeldLock(
      lockPerson(who.personId),
      "%for no key update%",
      transactional(Effect.provideService(command, CurrentPrincipal, admin))
    );

    assert.strictEqual(
      meeting.waiting,
      1,
      `${name} waits for the person's row lock`
    );
    assert.isTrue(meeting.stillRunning);

    assert.deepStrictEqual(
      meeting.wrote,
      [],
      `${name} has written to no table while it waits: it holds no write lock`
    );

    assert.isFalse(
      meeting.hasTransactionId,
      `${name} has no transaction id while it waits: it has written and row-locked nothing`
    );

    assert.isTrue(Exit.isSuccess(meeting.exit), `${name} succeeds`);

    assert.notDeepEqual(
      yield* membershipsOf(who.personId),
      before,
      `${name} writes a membership once the lock is let go`
    );
  }
);

layer(teamsDatabase, { excludeTestServices: true })(
  "the membership commands of the model take the person's row lock before they write",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      // The current semester is Høst 2026. An Active membership runs from it to Vår 2027.
      const active = { end: VAR_2027, start: HOST_2026 };

      it.effect("addMember", () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const who = yield* fresh("cmdadd");

          yield* waitsForThePersonsLock(
            "addMember",
            who,
            TeamsEndpoints.createMembership({
              leader: false,
              personId: who.personId,
              positionId: who.positionId,
              start: HOST_2026,
              teamId: who.teamId,
            })
          );
        })
      );

      it.effect("extend", () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const who = yield* fresh("cmdextend");
          const base = yield* placeMembership(who, active);

          yield* waitsForThePersonsLock(
            "extend",
            who,
            TeamsEndpoints.extendMembership({
              end: advanceSemester(VAR_2027, 1),
              id: base.id,
            })
          );
        })
      );

      it.effect("endEarly", () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const who = yield* fresh("cmdend");
          const base = yield* placeMembership(who, active);

          yield* waitsForThePersonsLock(
            "endEarly",
            who,
            TeamsEndpoints.endEarlyMembership({
              id: base.id,
              semester: VAR_2027,
            })
          );
        })
      );

      it.effect("change", () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const who = yield* fresh("cmdchange");
          const base = yield* placeMembership(who, active);

          yield* waitsForThePersonsLock(
            "change",
            who,
            TeamsEndpoints.changeMembership({ from: VAR_2027, id: base.id })
          );
        })
      );

      it.effect("cancel", () =>
        Effect.gen(function* effectProgram() {
          yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
          const who = yield* fresh("cmdcancel");

          const planned = yield* placeMembership(who, {
            end: VAR_2027,
            start: VAR_2027,
          });

          yield* waitsForThePersonsLock(
            "cancel",
            who,
            TeamsEndpoints.deleteMembership({ id: planned.id })
          );
        })
      );
    });
  }
);
