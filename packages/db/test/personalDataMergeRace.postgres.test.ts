/**
 * Spec 0007b falsifier 6, the race: a merge and a write about one of the two people at the same time. Every write of a
 * table that a person owns takes the person's lock first, and the merge locks both people (and the admin list before
 * them), so in any interleaving the write either happens before the merge and moves with the rows, or finds a tombstone
 * and is refused as missing; no row is left that names the tombstone. Each race runs 300 rounds in fresh state and prints
 * each loser's full Cause when one fails. The controls are deterministic: the merge waits for a writer that holds the
 * person's lock (and writes nothing while it waits), and it does not wait for a writer that wrote without the lock, which
 * leaves a row that names the tombstone every time.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  ConsentRepository,
  EmailAddress,
  MembershipRepository,
  PersonRepository,
  lockAdminList,
  answerRecord,
} from "@vektorprogrammet/domain";
import type {
  FieldOfStudyId,
  PositionId,
  TeamId,
  NotFound,
  PersonId,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { activeAdmin, noAdmins } from "./support/accountsWorld.ts";
import { postgresDatabase } from "./support/database.ts";
import { mergeAs, rowsNaming } from "./support/personalDataActors.ts";
import { meetsHeldLock, raceReport, raceTwo } from "./support/race.ts";
import { asPerson, lockPerson, semester, world } from "./support/teamsWorld.ts";

/** The number of rounds of each race. */
const ROUNDS = 300;

const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00Z");
const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

/** The tables that the writers write: after a round, none of them names the merged person. */
const WRITTEN = ["account", "consent", "membership"] as const;

/** The rows that a world gives a writer: where to put a membership, and which field of study a person has. */
interface Setting {
  readonly fieldOfStudyId: FieldOfStudyId;
  readonly positionId: PositionId;
  readonly teamId: TeamId;
}

/** A pair of people for one round. */
const makePair = Effect.fnUntraced(function* makePair(
  setting: Setting,
  round: string
) {
  const people = yield* PersonRepository;

  const into = yield* people.create({
    email: EmailAddress.make(`into.${round}@example.org`),
    fieldOfStudyId: setting.fieldOfStudyId,
    name: `Into ${round}`,
  });

  const from = yield* people.create({
    email: EmailAddress.make(`from.${round}@example.org`),
    fieldOfStudyId: setting.fieldOfStudyId,
    name: `From ${round}`,
  });

  return { from, into };
});

/** What a write came to: it ran (before the merge) or was refused as missing (after it, when the person is a tombstone). */
type Outcome = "refused" | "written";

/** The write, as one of two outcomes. Any other failure is a defect, which the round reports with its Cause. */
const attempt = <A, E, R>(write: Effect.Effect<A, E | NotFound, R>) =>
  write.pipe(
    Effect.as<Outcome>("written"),
    Effect.catchTag("NotFound", () => Effect.succeed<Outcome>("refused")),
    Effect.orDie
  );

/** What each writer does to the person that is being merged away, under the lock that every command takes. */
const writersOf = Effect.fnUntraced(function* writersOf(setting: Setting) {
  const accounts = yield* AccountRepository;
  const consents = yield* ConsentRepository;
  const memberships = yield* MembershipRepository;

  return {
    consent: (personId: PersonId) =>
      attempt(
        asPerson(personId, (locked) =>
          consents.record(locked, "news", answerRecord("news", true, NOW))
        )
      ),
    invite: (personId: PersonId) =>
      attempt(asPerson(personId, (locked) => accounts.invite(locked))),
    membership: (personId: PersonId) =>
      attempt(
        asPerson(personId, (locked) =>
          memberships.insert(locked, {
            end: semester("HOST", 2025),
            leader: false,
            positionId: setting.positionId,
            start: semester("HOST", 2025),
            teamId: setting.teamId,
          })
        )
      ),
    profile: (personId: PersonId) =>
      attempt(
        asPerson(personId, (locked) =>
          accounts.updateProfile(locked, {
            email: EmailAddress.make(`changed.${personId}@example.org`),
            fieldOfStudyId: setting.fieldOfStudyId,
            name: `Changed ${personId}`,
          })
        )
      ),
  };
});

/** Which row a successful writer leaves for the survivor to find, by table; the profile change leaves none. */
const leftBehind = {
  consent: "consent",
  invite: "account",
  membership: "membership",
  profile: null,
} as const;

type WriterName = keyof typeof leftBehind;

/**
 * The checks of one round, in whichever order the two ran: the merge always succeeds; the write ran (it came first) or
 * was refused as missing (the person was already a tombstone), never a defect or a deadlock; no row names the tombstone;
 * and a write that came first moved with the rows. Returns whether the write came first.
 */
const checkRound = Effect.fnUntraced(function* checkRound(
  name: WriterName,
  round: number,
  people: { readonly from: number; readonly into: number },
  exits: {
    readonly merged: Exit.Exit<unknown, unknown>;
    readonly written: Exit.Exit<Outcome>;
  }
) {
  const report = raceReport(round, [exits.merged, exits.written]);

  assert.isTrue(Exit.isSuccess(exits.merged), report);
  assert.isTrue(Exit.isSuccess(exits.written), report);

  assert.deepStrictEqual(yield* rowsNaming(people.from, WRITTEN), {}, report);

  const table = leftBehind[name];

  const writerFirst =
    Exit.isSuccess(exits.written) && exits.written.value === "written";

  if (writerFirst && table !== null) {
    assert.strictEqual(
      (yield* rowsNaming(people.into, WRITTEN))[table],
      1,
      report
    );
  }

  return writerFirst;
});

layer(postgresDatabase({ maxConnections: 30 }), { excludeTestServices: true })(
  "spec 0007b falsifier 6: merge against concurrent writes",
  (it) => {
    /** A world of its own for each test (tests share one database), and one Active administrator who does the merging. */
    const arrange = Effect.fnUntraced(function* arrange(tag: string) {
      yield* noAdmins;
      const arranged = yield* world(tag);
      const admin = arranged.person;
      yield* activeAdmin(admin.id, FAR);

      const setting: Setting = {
        fieldOfStudyId: arranged.fieldOfStudy.id,
        positionId: arranged.memberPosition,
        teamId: arranged.team.id,
      };

      return { admin: admin.id, setting };
    });

    for (const name of [
      "consent",
      "invite",
      "membership",
      "profile",
    ] as const) {
      it.effect(
        `${ROUNDS} rounds: a merge and a ${name} write of the merged person race; the write is moved or refused, and no row names the tombstone`,
        () =>
          Effect.gen(function* rounds() {
            const { admin, setting } = yield* arrange(`mgrace${name}`);
            const write = (yield* writersOf(setting))[name];
            const writerFirsts: boolean[] = [];

            for (const round of Arr.range(1, ROUNDS)) {
              const { from, into } = yield* makePair(
                setting,
                `${name}${round}`
              );

              // The merge takes the admin list's lock and then both people's, and the write takes one: started together
              // the write nearly always wins, and started 15 ms later it always loses. A merge takes a few milliseconds,
              // so starting the write 0 to 4 ms later (by round) races both interleavings.
              const [merged, written] = yield* raceTwo(
                mergeAs(admin, into.id, from.id),
                write(from.id).pipe(Effect.delay(`${round % 5} millis`))
              );

              writerFirsts.push(
                yield* checkRound(
                  name,
                  round,
                  { from: from.id, into: into.id },
                  { merged, written }
                )
              );
            }

            // Both interleavings were raced: the write before the merge (its row moved) and after it (refused as missing).
            const writerFirst = Arr.filter(writerFirsts, Boolean).length;
            const mergeFirst = writerFirsts.length - writerFirst;

            const raced = `${ROUNDS} rounds of ${name}: write first in ${writerFirst}, merge first in ${mergeFirst}`;

            assert.strictEqual(writerFirsts.length, ROUNDS, raced);
            assert.isAbove(writerFirst, 0, raced);
            assert.isAbove(mergeFirst, 0, raced);
          }),
        { timeout: 280_000 }
      );
    }

    it.effect(
      "a merge waits for a writer that holds the merged person's lock, writes nothing while it waits, and then moves what the writer wrote",
      () =>
        Effect.gen(function* waits() {
          const { admin, setting } = yield* arrange("mgwaits");
          const { from, into } = yield* makePair(setting, "waits");

          const meeting = yield* meetsHeldLock(
            Effect.andThen(
              lockPerson(from.id),
              Effect.flatMap(
                SqlClient,
                (
                  sql
                ) => sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
                values ('HOST', 2025, ${from.id}, ${setting.positionId}, 'HOST', 2025, ${setting.teamId})`
              )
            ),
            "%for no key update%",
            mergeAs(admin, into.id, from.id)
          );

          assert.strictEqual(
            meeting.waiting,
            1,
            "the merge did not wait for the person's lock"
          );

          assert.isTrue(meeting.stillRunning);

          assert.deepStrictEqual(
            meeting.wrote,
            [],
            "the merge wrote before it had both locks"
          );

          assert.isTrue(Exit.isSuccess(meeting.exit));

          // The writer's row, committed after the merge began to wait, moved with the rest.
          assert.deepStrictEqual(yield* rowsNaming(from.id, WRITTEN), {});
          assert.strictEqual(
            (yield* rowsNaming(into.id, WRITTEN)).membership,
            1
          );
        })
    );

    it.effect(
      "a merge takes the admin list's lock before any person's: it waits for a holder of the list, with no row locked and nothing written, and then goes on",
      () =>
        Effect.gen(function* waitsForTheList() {
          const { admin, setting } = yield* arrange("mgwaitslist");
          const { from, into } = yield* makePair(setting, "waitslist");

          const meeting = yield* meetsHeldLock(
            lockAdminList,
            "%admin_list%for no key update%",
            mergeAs(admin, into.id, from.id)
          );

          assert.strictEqual(
            meeting.waiting,
            1,
            "the merge did not wait for the admin list's lock"
          );

          assert.isTrue(meeting.stillRunning);

          assert.deepStrictEqual(
            meeting.wrote,
            [],
            "the merge wrote before it had the admin list's lock"
          );

          // A transaction gets its id with its first row lock or write: the merge had locked no person when it waited.
          assert.isFalse(
            meeting.hasTransactionId,
            "the merge locked a person before it had the admin list's lock"
          );

          assert.isTrue(Exit.isSuccess(meeting.exit));
        })
    );

    it.effect(
      "negative control: a writer that does not take the lock is not waited for, and its row names the tombstone",
      () =>
        Effect.gen(function* unlocked() {
          const { admin, setting } = yield* arrange("mgunlocked");
          const { from, into } = yield* makePair(setting, "unlocked");

          const meeting = yield* meetsHeldLock(
            // The same write as above, without `lockPerson`: nothing makes the merge wait.
            Effect.flatMap(
              SqlClient,
              (
                sql
              ) => sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
              values ('HOST', 2025, ${from.id}, ${setting.positionId}, 'HOST', 2025, ${setting.teamId})`
            ),
            "%for no key update%",
            mergeAs(admin, into.id, from.id)
          );

          assert.strictEqual(
            meeting.waiting,
            0,
            "the merge waited although nothing locked the person"
          );

          assert.isTrue(Exit.isSuccess(meeting.exit));

          // The writer committed after the merge: a row names the tombstone, and the survivor never got it.
          assert.strictEqual(
            (yield* rowsNaming(from.id, WRITTEN)).membership,
            1,
            "the unlocked writer left no orphan"
          );

          assert.isUndefined((yield* rowsNaming(into.id, WRITTEN)).membership);
        })
    );

    it.effect(
      "negative control: the same unlocked write, committed before the merge, is moved: the orphan above is the lock's absence and nothing else",
      () =>
        Effect.gen(function* committed() {
          const { admin, setting } = yield* arrange("mgcommitted");
          const { from, into } = yield* makePair(setting, "committed");
          const sql = yield* SqlClient;

          yield* sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
            values ('HOST', 2025, ${from.id}, ${setting.positionId}, 'HOST', 2025, ${setting.teamId})`;

          yield* mergeAs(admin, into.id, from.id);

          assert.isUndefined((yield* rowsNaming(from.id, WRITTEN)).membership);
          assert.strictEqual(
            (yield* rowsNaming(into.id, WRITTEN)).membership,
            1
          );
        })
    );
  }
);
