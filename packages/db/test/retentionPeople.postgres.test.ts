/**
 * Spec 0007b falsifier 2, the parts that the table of rules does not say: a person is anonymised one year after their
 * last activity and five while a `keepDetails` consent is current (withdrawing falls back to one), the history row of an
 * engagement outlives the anonymisation by nine years, the audit row of a run holds integer counts and no value, twenty
 * concurrent runs end in the state one run leaves in each of fifty rounds of fresh state, and a run waits for the lock of a person whom a command is changing
 * and then sees what that command wrote, where a command that does not take the lock is not waited for.
 */
import { assert, layer } from "@effect/vitest";
import {
  Counts,
  PersonalDataDeclaration,
  afterDuration,
} from "@vektorprogrammet/domain";
import { eq } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Record as Rec,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { schema, transactional } from "../src/index.ts";
import { Drizzle, postgresJobDatabase } from "./support/database.ts";
import { encodeJson } from "./support/json.ts";
import { countWhere } from "./support/personalDataActors.ts";
import { meetsHeldLock, race, raceReport } from "./support/race.ts";
import { HOST_2020_ENDS } from "./support/retentionBuilders.ts";
import { at, nightlyCounts, runRetention } from "./support/retentionRun.ts";
import { lockPerson, world } from "./support/teamsWorld.ts";

const { years } = PersonalDataDeclaration;

const T0 = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const secondsFrom = (instant: DateTime.Utc, seconds: number) =>
  DateTime.add(instant, { seconds });

const peopleState = Effect.fnUntraced(function* peopleState(
  ids: readonly number[]
) {
  const sql = yield* SqlClient;

  return yield* sql<{
    readonly anonymised: boolean;
    readonly email: string;
    readonly id: number;
    readonly name: string;
  }>`select id, anonymised_at is not null as anonymised, email, name
    from person where id in ${sql.in(ids)} order by id`;
});

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0007b falsifier 2: the person core, the history and the audit row",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "a person is anonymised one year after their last activity, five while keepDetails is current (withdrawing falls back to one), and the history row stays ten years",
        () =>
          Effect.gen(function* scenario() {
            const sql = yield* SqlClient;
            yield* at(T0);

            const alma = yield* world("alma");
            const berit = yield* world("berit");
            const cato = yield* world("cato");
            const dina = yield* world("dina");

            const ids = Arr.map(
              [alma, berit, cato, dina],
              ({ person }) => person.id
            );

            yield* sql`insert into consent (given_at, kind, person_id, text_version)
              values (${DateTime.toDateUtc(T0)}, 'keepDetails', ${berit.person.id}, 1)`;

            yield* sql`insert into consent (given_at, kind, person_id, text_version, withdrawn_at)
              values (${DateTime.toDateUtc(T0)}, 'keepDetails', ${cato.person.id}, 1, ${DateTime.toDateUtc(secondsFrom(T0, 86_400))})`;

            // Dina's only engagement ended with Høst 2020: her last activity is long past, her history row is not.
            yield* sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
              values ('HOST', 2020, ${dina.person.id}, ${dina.memberPosition}, 'HOST', 2020, ${dina.team.id})`;

            const oneYear = afterDuration(T0, years(1));
            const fiveYears = afterDuration(T0, years(5));
            const historyEnds = afterDuration(HOST_2020_ENDS, years(10));

            const anonymisedAt = Effect.fnUntraced(function* anonymisedAt(
              instant: DateTime.Utc
            ) {
              yield* at(instant);
              yield* runRetention;

              return Arr.map(yield* peopleState(ids), (row) => row.anonymised);
            });

            // One second inside the first year: only Dina, whose year ended in 2021, is anonymised.
            assert.deepStrictEqual(
              yield* anonymisedAt(secondsFrom(oneYear, -1)),
              [false, false, false, true]
            );

            assert.strictEqual(
              yield* countWhere("membership", `person_id = ${dina.person.id}`),
              1
            );

            // One second outside it: Alma has had no activity since she was created, and Cato withdrew.
            assert.deepStrictEqual(
              yield* anonymisedAt(secondsFrom(oneYear, 1)),
              [true, false, true, true]
            );

            // Withdrawing keepDetails fell back to one year: Cato's consent row went with his core, Berit's stays.
            assert.strictEqual(
              yield* countWhere("consent", `person_id = ${cato.person.id}`),
              0
            );

            assert.strictEqual(
              yield* countWhere("consent", `person_id = ${berit.person.id}`),
              1
            );

            // Dina's history row outlives her anonymisation by nine years: it is there one second inside ten years…
            yield* anonymisedAt(secondsFrom(historyEnds, -1));

            assert.strictEqual(
              yield* countWhere("membership", `person_id = ${dina.person.id}`),
              1
            );

            // …and gone one second outside.
            yield* anonymisedAt(secondsFrom(historyEnds, 1));

            assert.strictEqual(
              yield* countWhere("membership", `person_id = ${dina.person.id}`),
              0
            );

            // Berit's five years: intact one second inside, anonymised one second outside, her consent with her.
            assert.deepStrictEqual(
              yield* anonymisedAt(secondsFrom(fiveYears, -1)),
              [true, false, true, true]
            );

            assert.deepStrictEqual(
              yield* anonymisedAt(secondsFrom(fiveYears, 1)),
              [true, true, true, true]
            );

            assert.strictEqual(
              yield* countWhere("consent", `person_id = ${berit.person.id}`),
              0
            );

            // An anonymised person is a record with no data: name and e-mail say so, and say nothing of the person.
            const state = yield* peopleState(ids);

            for (const row of state) {
              assert.strictEqual(row.name, "Anonymisert");
              assert.strictEqual(
                row.email,
                `anonymisert-${row.id}@vektorprogrammet.invalid`
              );
            }
          })
      );

      it.effect(
        "every run writes one audit row as System(retention) whose counts are integers, and no value of the seeded data is in any of them; a count that is not a number is refused by the table",
        () =>
          Effect.gen(function* auditRows() {
            const db = yield* Drizzle;
            const sql = yield* SqlClient;
            yield* at(T0);

            const eva = yield* world("eva");
            const seeds = [eva.person.name, eva.person.email, "Eva"];
            const later = afterDuration(T0, years(2));

            yield* at(later);
            const run = yield* runRetention;

            assert.isAbove(run.counts.person ?? 0, 0);

            const rows = yield* db
              .select()
              .from(schema.auditLog)
              .where(eq(schema.auditLog.action, "retention.ran"));

            assert.isAbove(rows.length, 0);

            for (const row of rows) {
              assert.strictEqual(row.systemJob, "retention");
              assert.isNull(row.personId);
              assert.isTrue(Schema.is(Counts)(row.counts));
            }

            const serialised = yield* encodeJson(rows);

            for (const seed of seeds) {
              assert.isFalse(
                serialised.includes(seed),
                `the audit rows contain ${seed}`
              );
            }

            // The table keeps it so: a value in `counts` is refused, a number is not.
            const insert = (counts: string) =>
              sql`insert into audit_log (action, at, entity, entity_key, system_job, counts)
                values ('retention.ran', now(), 'Retention', 'x', 'retention', ${counts}::jsonb)`.pipe(
                Effect.exit
              );

            assert.isTrue(Exit.isFailure(yield* insert('{"person": "Eva"}')));
            assert.isTrue(Exit.isFailure(yield* insert("[1, 2]")));
            assert.isTrue(Exit.isSuccess(yield* insert('{"person": 1}')));
          })
      );
    });
  }
);

/**
 * Each round starts twenty concurrent runs against fresh people. The runs form 190 possible pairs, but the test does
 * not prove that every pair interleaves. Fifty rounds exercise the resulting contention.
 */
const RUNS = 20;
const ROUNDS = 50;

layer(postgresJobDatabase("Apply", { maxConnections: 30 }), {
  excludeTestServices: true,
})("spec 0007b falsifier 2: concurrent runs", (it) => {
  it.effect(
    `${RUNS} concurrent runs end in the state that one run leaves, and none of them fails, in each of ${ROUNDS} rounds of fresh state`,
    () =>
      Effect.gen(function* concurrentRuns() {
        const sql = yield* SqlClient;
        const now = afterDuration(T0, years(3));

        const run = transactional(nightlyCounts(now));

        for (const round of Arr.range(1, ROUNDS)) {
          // Six people who were last active before T0: expired at `now`. Four more created after `now - 1 year`: not.
          const expired = yield* Effect.forEach(Arr.range(1, 6), (n) =>
            world(`old${round}x${n}`)
          );

          const current = yield* Effect.forEach(Arr.range(1, 4), (n) =>
            world(`new${round}x${n}`)
          );

          yield* sql`update person set created_at = ${DateTime.toDateUtc(T0)} where id in ${sql.in(Arr.map(expired, ({ person }) => person.id))}`;
          yield* sql`update person set created_at = ${DateTime.toDateUtc(secondsFrom(now, -86_400))} where id in ${sql.in(Arr.map(current, ({ person }) => person.id))}`;

          const exits = yield* race(Arr.makeBy(RUNS, () => run));
          const report = raceReport(round, exits);

          assert.isTrue(Arr.every(exits, Exit.isSuccess), report);

          const state = yield* peopleState(
            Arr.map([...expired, ...current], ({ person }) => person.id)
          );

          assert.deepStrictEqual(
            Arr.map(state, (row) => row.anonymised),
            [...Arr.makeBy(6, () => true), ...Arr.makeBy(4, () => false)],
            report
          );

          // A run after the race has nothing left to do: the race left the state that one run leaves.
          const after = yield* run;

          assert.isTrue(
            Arr.every(Rec.values(after), (n) => n === 0),
            `round ${round}: a run after the race still had work to do`
          );
        }
      }),
    // Each round is twenty runs that each sweep every table, so it costs about two tenths of a second on a quiet
    // machine; fifty rounds are ten seconds, and a loaded machine takes several times that.
    { timeout: 280_000 }
  );

  it.effect(
    "negative control: a run that dies fails the round, and the report names the round and holds the Cause",
    () =>
      Effect.gen(function* aRunDies() {
        const run = transactional(nightlyCounts(T0));

        const exits = yield* race([run, Effect.die("a defect named boom")]);

        assert.isFalse(Arr.every(exits, Exit.isSuccess));
        assert.include(raceReport(7, exits), "round 7");
        assert.include(raceReport(7, exits), "a defect named boom");
      })
  );
});

/** What a command writes: a membership that ends far ahead, which makes the person active again. */
const newMembership = (who: {
  readonly personId: number;
  readonly positionId: number;
  readonly teamId: number;
}) =>
  Effect.flatMap(
    SqlClient,
    (
      sql
    ) => sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
      values ('HOST', 2099, ${who.personId}, ${who.positionId}, 'HOST', 2099, ${who.teamId})`
  );

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0007b: a run waits for the lock of a person that a command is changing",
  (it) => {
    /** A person whose last activity ended a year before `now`, and the instant of the run. */
    const expiredPerson = Effect.fnUntraced(function* expiredPerson(
      tag: string
    ) {
      const sql = yield* SqlClient;
      const arranged = yield* world(tag);
      const now = afterDuration(T0, years(2));

      yield* sql`update person set created_at = ${DateTime.toDateUtc(T0)} where id = ${arranged.person.id}`;

      return {
        now,
        personId: arranged.person.id,
        positionId: arranged.memberPosition,
        teamId: arranged.team.id,
      };
    });

    it.effect(
      "a command that takes the person's lock first is waited for: the run writes nothing while it waits, and then leaves the person alone",
      () =>
        Effect.gen(function* withTheLock() {
          const person = yield* expiredPerson("lockedwriter");

          const outcome = yield* meetsHeldLock(
            Effect.andThen(lockPerson(person.personId), newMembership(person)),
            "%for no key update%",
            transactional(nightlyCounts(person.now))
          );

          assert.strictEqual(
            outcome.waiting,
            1,
            "the run did not wait for the lock"
          );
          assert.isTrue(outcome.stillRunning);
          assert.deepStrictEqual(
            outcome.wrote,
            [],
            "the run wrote before it had the lock"
          );
          assert.isFalse(outcome.hasTransactionId);
          assert.isTrue(Exit.isSuccess(outcome.exit));

          const [state] = yield* peopleState([person.personId]);
          assert.isFalse(
            state?.anonymised,
            "the run anonymised a person who had just become active"
          );
        })
    );

    it.effect(
      "negative control: a command that writes without the person's lock is not waited for, and the person is anonymised although the command was about to make them active",
      () =>
        Effect.gen(function* withoutTheLock() {
          const person = yield* expiredPerson("unlockedwriter");

          const outcome = yield* meetsHeldLock(
            newMembership(person),
            "%for no key update%",
            transactional(nightlyCounts(person.now))
          );

          assert.strictEqual(
            outcome.waiting,
            0,
            "the run waited although nothing locked the person"
          );
          assert.isTrue(Exit.isSuccess(outcome.exit));

          const [state] = yield* peopleState([person.personId]);
          assert.isTrue(
            state?.anonymised,
            "the run left the person alone without being made to wait"
          );
        })
    );
  }
);
