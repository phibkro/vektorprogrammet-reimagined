/**
 * Spec 0006b on real PostgreSQL: the ordered multi-lock (falsifier 2), the machine-applied transition (falsifier 4), and
 * the rules of the lock registry that make a token mean what it says (contracts 1 to 3). Each race repeats in fresh
 * state, prints every loser's full Cause when it fails, and names its round count. The overlap races of spec 0006 R6
 * (falsifier 3) stay in `teams.postgres.test.ts`, where they were written.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  AggregateLocks,
  Accounts,
  InTransaction,
  Machine,
  PersonId,
  lockAdminList,
} from "@vektorprogrammet/domain";
import type { Locked } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Option,
  Predicate,
  Ref,
} from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";

import { Aggregates } from "../src/aggregate/aggregates.ts";
import { Person } from "../src/aggregate/declaration.ts";
import { transactional } from "../src/index.ts";
import * as schema from "../src/schema.ts";
import { activateAccount } from "./support/accountsWorld.ts";
import { postgresDatabase } from "./support/database.ts";
import {
  describeExit,
  lockableElsewhere,
  race,
  raceReport,
} from "./support/race.ts";
import {
  asPerson,
  lockPerson,
  placeMembership,
  semester,
  twoPeople,
  world,
} from "./support/teamsWorld.ts";

/** The bound of every race here. */
const RACE_ROUNDS = 300;

const STRESS_TIMEOUT_MS = 120_000;

/** How long a transaction keeps its locks, so that the other one meets them. */
const HOLD = "2 millis";

/** The construct: both rows in one statement, whatever the order of the arguments. */
const lockTogether = (ids: readonly number[]) =>
  transactional(
    Effect.gen(function* holdBoth() {
      yield* AggregateLocks.use((locks) => locks.lockAll("Person", ids));
      yield* Effect.sleep(HOLD);
    })
  );

/**
 * The negative control: the lock written by hand, one row after the other in the order given. The deadlock detector
 * waits `deadlock_timeout` (1 s) before it looks, so this transaction shortens it for itself (`SET LOCAL`, which ends
 * with the transaction): the control only has to show that the race exists, not wait for it.
 */
const lockOneByOne = (ids: readonly number[]) =>
  transactional(
    Effect.gen(function* holdOneByOne() {
      const sql = yield* SqlClient;
      yield* sql`set local deadlock_timeout = '20ms'`;

      for (const id of ids) {
        yield* sql`select id from person where id = ${id} for no key update`;
        yield* Effect.sleep(HOLD);
      }
    })
  );

/** SQLSTATE 40P01: PostgreSQL's "deadlock detected", which the driver reports as a `DeadlockError`. */
const isDeadlock = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("DeadlockError");

/** Whether the exit is a defect of this tag. */
const diedWith = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
  Exit.hasDies(exit) && Predicate.isTagged(tag)(Cause.squash(exit.cause));

/** A token that no lock made: what a caller would have to forge. The compiler refuses it; the registry must too. */
const forged = (id: number, root: "AdminList" | "Person") =>
  // SAFETY: this is the forgery under test (EX-0025).
  cast<{ id: number; root: string }, Locked<"Person">>({ id, root });

/** A decision read of the membership rows, through a token. */
const readMemberships = (token: Locked<"Person">) =>
  Aggregates.use((aggregates) =>
    aggregates.select(token, Person.owned.membership)
  );

const ownersOf = (rows: readonly { readonly personId: number }[]) =>
  Arr.map(rows, (row) => row.personId);

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0006b: the lock construct on PostgreSQL",
  (it) => {
    it.effect(
      `falsifier 2: ${RACE_ROUNDS} rounds of two lockAll calls over the same two people in opposite order end without a deadlock`,
      () =>
        Effect.gen(function* orderedRounds() {
          const { fieldOfStudy } = yield* world("ordered");

          for (const round of Arr.range(1, RACE_ROUNDS)) {
            const [first, second] = yield* twoPeople(
              fieldOfStudy.id,
              `ordered${round}`
            );

            const exits = yield* race([
              lockTogether([first.id, second.id]),
              lockTogether([second.id, first.id]),
            ]);

            assert.strictEqual(
              Arr.filter(exits, Exit.isFailure).length,
              0,
              raceReport(round, exits)
            );
          }

          yield* Effect.logInfo(
            `${RACE_ROUNDS} rounds x 2 opposite-order lockAll transactions: 0 failures, 0 deadlocks`
          );
        }),
      STRESS_TIMEOUT_MS
    );

    it.effect(
      `falsifier 2, negative control: the same two locks written by hand in opposite order deadlock (SQLSTATE 40P01) within ${RACE_ROUNDS} rounds`,
      () =>
        Effect.gen(function* handWrittenRounds() {
          const { fieldOfStudy } = yield* world("handwritten");
          let deadlocked = 0;
          let rounds = 0;

          for (const round of Arr.range(1, RACE_ROUNDS)) {
            const [first, second] = yield* twoPeople(
              fieldOfStudy.id,
              `hand${round}`
            );

            const exits = yield* race([
              lockOneByOne([first.id, second.id]),
              lockOneByOne([second.id, first.id]),
            ]);

            rounds = round;
            deadlocked = Arr.filter(exits, isDeadlock).length;

            if (deadlocked > 0) {
              yield* Effect.logInfo(
                `the hand-written opposite-order lock deadlocked in round ${round}:\n${raceReport(round, exits)}`
              );

              break;
            }
          }

          assert.isAbove(
            deadlocked,
            0,
            `no deadlock in ${rounds} rounds: the control cannot fail, so the ordered test above proves nothing`
          );
        }),
      STRESS_TIMEOUT_MS
    );

    it.effect(
      `falsifier 4: ${RACE_ROUNDS} rounds of two concurrent transitions from the same state: exactly one wins and the other is a Conflict`,
      () =>
        Effect.gen(function* lostUpdateRounds() {
          const { fieldOfStudy } = yield* world("lostupdate");

          const moment: Accounts.AccountTransition = {
            actorId: null,
            lastActiveAdmin: false,
            personId: PersonId.make(1),
          };

          const deactivate = yield* Effect.fromOption(
            Arr.head(
              Machine.available(
                Accounts.AccountMachine,
                "deactivateAccount",
                "Active",
                moment
              )
            )
          ).pipe(Effect.orDie);

          for (const round of Arr.range(1, RACE_ROUNDS)) {
            const [subject] = yield* twoPeople(fieldOfStudy.id, `lost${round}`);

            yield* asPerson(subject.id, activateAccount);

            const transition = transactional(
              Effect.flatMap(lockPerson(subject.id), (locked) =>
                AccountRepository.use((accounts) =>
                  accounts.transition(locked, deactivate)
                )
              )
            );

            const exits = yield* race([transition, transition]);
            const report = raceReport(round, exits);
            const winners = Arr.filter(exits, Exit.isSuccess);
            const losers = Arr.filter(exits, Exit.isFailure);

            assert.strictEqual(winners.length, 1, report);
            assert.strictEqual(losers.length, 1, report);

            assert.isTrue(
              Arr.every(losers, (loser) =>
                Option.exists(
                  Exit.findErrorOption(loser),
                  Predicate.isTagged("Conflict")
                )
              ),
              report
            );

            const stored = yield* AccountRepository.use((accounts) =>
              accounts.find(subject.id)
            );

            assert.isTrue(
              Option.exists(stored, (account) =>
                Predicate.isTagged(account.state, "Deactivated")
              ),
              report
            );
          }

          yield* Effect.logInfo(
            `${RACE_ROUNDS} rounds x 2 concurrent deactivations from Active: 1 winner and 1 Conflict every round`
          );
        }),
      STRESS_TIMEOUT_MS
    );

    it.effect(
      `falsifier 4, negative control: an unconditional write of the state column lets both transitions win, in each of ${RACE_ROUNDS} rounds`,
      () =>
        Effect.gen(function* unconditionalRounds() {
          const { fieldOfStudy } = yield* world("unconditional");
          let bothWon = 0;

          for (const round of Arr.range(1, RACE_ROUNDS)) {
            const [subject] = yield* twoPeople(
              fieldOfStudy.id,
              `direct${round}`
            );

            yield* asPerson(subject.id, activateAccount);

            const write = transactional(
              Effect.gen(function* directWrite() {
                yield* lockPerson(subject.id);
                const sql = yield* SqlClient;

                const rows =
                  yield* sql`update account set state = 'Deactivated' where person_id = ${subject.id} returning person_id`;

                return rows.length;
              })
            );

            const exits = yield* race([write, write]);

            bothWon +=
              Arr.filter(
                exits,
                (exit) => Exit.isSuccess(exit) && exit.value === 1
              ).length === 2
                ? 1
                : 0;
          }

          assert.strictEqual(
            bothWon,
            RACE_ROUNDS,
            "a state written without `state = ANY(from)` reports a win to both callers: that is the lost update the construct removes"
          );
        }),
      STRESS_TIMEOUT_MS
    );

    it.effect(
      "a lock that would break the global order is a defect, found by the first run",
      () =>
        Effect.gen(function* orderViolation() {
          const { fieldOfStudy } = yield* world("violation");
          const [low, high] = yield* twoPeople(fieldOfStudy.id, "violation");

          const descending = yield* Effect.exit(
            transactional(
              Effect.gen(function* descending() {
                const locks = yield* AggregateLocks;
                yield* locks.lock("Person", high.id);
                yield* locks.lock("Person", low.id);
              })
            )
          );

          const ascending = yield* transactional(
            Effect.gen(function* ascending() {
              const locks = yield* AggregateLocks;
              const first = yield* locks.lock("Person", low.id);
              const both = yield* locks.lockAll("Person", [low.id, high.id]);
              const again = yield* locks.lock("Person", low.id);

              return { again, both, first };
            })
          );

          assert.isTrue(
            diedWith(descending, "LockOrderViolation"),
            "locking a lower row after a higher one"
          );

          assert.deepStrictEqual(
            Arr.map(ascending.both, (token) => token.id),
            [low.id, high.id],
            "lockAll returns the tokens in ascending order"
          );

          assert.deepStrictEqual(
            ascending.both[0],
            ascending.first,
            "a row that is held is not locked again"
          );

          assert.deepStrictEqual(ascending.again, ascending.first);
        })
    );

    it.effect(
      "the admin list comes before every person: the list after a person is a defect, the person after the list is not",
      () =>
        Effect.gen(function* acrossRoots() {
          const { fieldOfStudy } = yield* world("acrossroots");
          const [subject] = yield* twoPeople(fieldOfStudy.id, "acrossroots");

          const personThenList = yield* Effect.exit(
            transactional(
              Effect.gen(function* lockPersonThenList() {
                yield* lockPerson(subject.id);
                yield* lockAdminList;
              })
            )
          );

          const listThenPerson = yield* Effect.exit(
            transactional(
              Effect.gen(function* lockListThenPerson() {
                const adminList = yield* lockAdminList;
                const person = yield* lockPerson(subject.id);

                return { adminList, person };
              })
            )
          );

          assert.isTrue(
            diedWith(personThenList, "LockOrderViolation"),
            describeExit(personThenList)
          );
          assert.isTrue(
            Exit.isSuccess(listThenPerson),
            describeExit(listThenPerson)
          );
        })
    );

    it.effect("a root that is not there is NotFound, not a token", () =>
      Effect.gen(function* missingRoot() {
        const exit = yield* Effect.exit(
          transactional(
            AggregateLocks.use((locks) => locks.lock("Person", 2_000_000_000))
          )
        );

        assert.isTrue(
          Option.exists(
            Exit.findErrorOption(exit),
            Predicate.isTagged("NotFound")
          )
        );
      })
    );

    it.effect(
      "a lock outside a transaction is refused, even where InTransaction is forged: the adapter refuses the forged proof (spec 0019), and the lock registry still refuses a token outside a transaction",
      () =>
        Effect.gen(function* outsideTransaction() {
          const { fieldOfStudy } = yield* world("outside");
          const [subject] = yield* twoPeople(fieldOfStudy.id, "outside");

          const exit = yield* Effect.exit(
            AggregateLocks.use((locks) =>
              locks.lock("Person", subject.id)
            ).pipe(
              Effect.provideService(
                InTransaction,
                InTransaction.of({ kind: "database-transaction" })
              )
            )
          );

          assert.isTrue(
            diedWith(exit, "TransactionNotLive"),
            describeExit(exit)
          );

          // Defence in depth: where no proof is asked for, the registry itself refuses a token outside a transaction.
          const registry = yield* Effect.exit(
            Aggregates.use((aggregates) =>
              aggregates.assertHeld(Person, forged(subject.id, "Person"))
            )
          );

          assert.isTrue(
            diedWith(registry, "LockNotHeld"),
            describeExit(registry)
          );
        })
    );

    it.effect(
      "a token that no lock made, or respelled for another row, or of another root, or from a finished transaction, never reads or writes",
      () =>
        Effect.gen(function* refusedTokens() {
          const { fieldOfStudy } = yield* world("refused");
          const [held, other] = yield* twoPeople(fieldOfStudy.id, "refused");

          const tokenOfFinishedTransaction = yield* transactional(
            lockPerson(other.id)
          );

          const tokenOfFinishedTransactionForHeldRow = yield* transactional(
            lockPerson(held.id)
          );

          const refusals = yield* transactional(
            Effect.gen(function* refusals() {
              const heldToken = yield* lockPerson(held.id);

              return {
                anotherRoot: yield* Effect.exit(
                  readMemberships(forged(held.id, "AdminList"))
                ),
                finished: yield* Effect.exit(
                  readMemberships(tokenOfFinishedTransaction)
                ),
                honoured: yield* Effect.exit(
                  readMemberships(tokenOfFinishedTransactionForHeldRow)
                ),
                madeUp: yield* Effect.exit(
                  readMemberships(forged(other.id, "Person"))
                ),
                // A spread copies the brand and `id` is an ordinary property, so this type-checks as a token of `other`.
                respelled: yield* Effect.exit(
                  readMemberships({ ...heldToken, id: other.id })
                ),
                write: yield* Effect.exit(
                  Aggregates.use((aggregates) =>
                    aggregates.remove(
                      forged(other.id, "Person"),
                      Person.owned.adminGrant
                    )
                  )
                ),
              };
            })
          );

          const outside = yield* Effect.exit(
            readMemberships(tokenOfFinishedTransaction)
          );

          const attempts: readonly (readonly [
            string,
            Exit.Exit<unknown, unknown>,
          ])[] = [
            ["a token of another root", refusals.anotherRoot],
            ["a token of a finished transaction", refusals.finished],
            ["a token that no lock made", refusals.madeUp],
            [
              "a token respelled from a held one for a row that this transaction does not hold",
              refusals.respelled,
            ],
            ["a write with a token that no lock made", refusals.write],
            ["a token outside any transaction", outside],
          ];

          for (const [what, exit] of attempts) {
            assert.isTrue(
              diedWith(exit, "LockNotHeld"),
              `${what}: ${describeExit(exit)}`
            );
          }

          assert.isTrue(
            Exit.isSuccess(refusals.honoured),
            "a token names a row: while this transaction holds the row's lock, an older token of that row reads like a new one"
          );
        })
    );

    it.effect(
      "a savepoint that fails gives its locks back, in the registry and in PostgreSQL; one that succeeds keeps them for the transaction",
      () =>
        Effect.gen(function* savepoints() {
          const { fieldOfStudy } = yield* world("savepoint");
          const [rolledBack, kept] = yield* twoPeople(fieldOfStudy.id, "save");

          const outcome = yield* transactional(
            Effect.gen(function* levels() {
              const leaked = yield* Ref.make<Option.Option<Locked<"Person">>>(
                Option.none()
              );

              yield* Effect.exit(
                transactional(
                  Effect.gen(function* failingLevel() {
                    yield* Ref.set(
                      leaked,
                      Option.some(yield* lockPerson(rolledBack.id))
                    );

                    return yield* Effect.fail("roll the savepoint back");
                  })
                )
              );

              const survivor = yield* transactional(lockPerson(kept.id));
              const token = yield* Ref.get(leaked);

              return {
                keptLockedElsewhere: !(yield* lockableElsewhere(kept.id)),
                keptReads: yield* Effect.exit(readMemberships(survivor)),
                rolledBackLockable: yield* lockableElsewhere(rolledBack.id),
                rolledBackReads: Option.isSome(token)
                  ? yield* Effect.exit(readMemberships(token.value))
                  : Exit.die("no token leaked"),
              };
            })
          );

          assert.isTrue(
            diedWith(outcome.rolledBackReads, "LockNotHeld"),
            "the registry forgot the lock of the failed savepoint"
          );

          assert.isTrue(
            outcome.rolledBackLockable,
            "PostgreSQL released the lock of the failed savepoint"
          );

          assert.isTrue(
            Exit.isSuccess(outcome.keptReads),
            "the lock of the savepoint that succeeded is still held"
          );

          assert.isTrue(
            outcome.keptLockedElsewhere,
            "PostgreSQL still holds the lock of the savepoint that succeeded"
          );
        })
    );

    it.effect(
      "a decision read returns the rows of the locked owners and of nobody else",
      () =>
        Effect.gen(function* decisionReads() {
          const found = yield* world("decision");

          const [one, two] = yield* twoPeople(
            found.fieldOfStudy.id,
            "decision"
          );

          for (const personId of [one.id, two.id]) {
            yield* placeMembership(
              {
                personId,
                positionId: found.memberPosition,
                teamId: found.team.id,
              },
              { end: semester("VAR", 2027), start: semester("HOST", 2026) }
            );
          }

          const seen = yield* transactional(
            Effect.gen(function* reads() {
              const locks = yield* AggregateLocks;
              const first = yield* locks.lock("Person", one.id);
              const alone = yield* readMemberships(first);
              const both = yield* locks.lockAll("Person", [one.id, two.id]);

              const together = yield* Aggregates.use((aggregates) =>
                aggregates.select(both, Person.owned.membership)
              );

              return { alone: ownersOf(alone), together: ownersOf(together) };
            })
          );

          assert.deepStrictEqual(seen.alone, [one.id]);
          assert.sameMembers(seen.together, [one.id, two.id]);
        })
    );

    it.effect(
      "a set that names the owner's column or a machine's state is a defect, even where the types let it through",
      () =>
        Effect.gen(function* protectedColumns() {
          const { fieldOfStudy } = yield* world("protected");
          const [subject, other] = yield* twoPeople(fieldOfStudy.id, "protect");
          yield* asPerson(subject.id, activateAccount);

          // Values that are not fresh object literals pass the compiler's excess-property check.
          const reparent = { leader: true, personId: other.id };
          const restate = { state: "Active" };

          const attempts: readonly Exit.Exit<unknown, unknown>[] =
            yield* transactional(
              Effect.gen(function* attempts() {
                const locked = yield* lockPerson(subject.id);
                const aggregates = yield* Aggregates;

                return [
                  yield* Effect.exit(
                    aggregates.update(locked, Person.owned.membership, {
                      set: reparent,
                    })
                  ),
                  yield* Effect.exit(
                    aggregates.update(locked, Person.owned.account, {
                      set: restate,
                    })
                  ),
                ];
              })
            );

          for (const exit of attempts) {
            assert.isTrue(
              diedWith(exit, "ProtectedColumn"),
              describeExit(exit)
            );
          }
        })
    );

    it.effect(
      "an upsert whose target leaves the owner out never rewrites another owner's row, and still replaces its own",
      () =>
        Effect.gen(function* upsertAcrossOwners() {
          const { fieldOfStudy } = yield* world("upsert");
          const [owner, other] = yield* twoPeople(fieldOfStudy.id, "upsert");

          const issued = DateTime.toDateUtc(
            DateTime.makeUnsafe("2099-01-01T00:00:00Z")
          );

          const changed = DateTime.toDateUtc(
            DateTime.makeUnsafe("2099-06-01T00:00:00Z")
          );

          const taken = "1".repeat(64);
          const own = "2".repeat(64);

          // `code_hash_unique` is a unique index on the hash alone: a target without the owner column collides with
          // the row of whoever holds the hash.
          const upsert = (who: typeof owner, hash: string, expiresAt: Date) =>
            asPerson(who.id, (locked) =>
              Aggregates.use((aggregates) =>
                aggregates.insert(
                  locked,
                  Person.owned.code,
                  { expiresAt, hash, purpose: "activation", usedAt: null },
                  {
                    action: "replace",
                    set: { expiresAt },
                    target: [schema.code.hash],
                  }
                )
              )
            );

          yield* upsert(owner, taken, issued);
          const crossing = yield* upsert(other, taken, changed);
          yield* upsert(other, own, issued);
          const replacing = yield* upsert(other, own, changed);

          const kept = yield* asPerson(owner.id, (locked) =>
            Aggregates.use((aggregates) =>
              aggregates.select(locked, Person.owned.code)
            )
          );

          assert.deepStrictEqual(
            crossing,
            [],
            "the upsert wrote a row: it rewrote the row of the owner whose lock this transaction does not hold"
          );

          assert.deepStrictEqual(
            Arr.map(kept, (row) => [
              row.subject,
              row.hash,
              row.expiresAt.getTime(),
            ]),
            [[owner.id, taken, issued.getTime()]],
            "another owner's row was rewritten"
          );

          assert.deepStrictEqual(
            Arr.map(replacing, (row) => [row.subject, row.expiresAt.getTime()]),
            [[other.id, changed.getTime()]],
            "an upsert on the owner's own row replaces it"
          );
        })
    );
  }
);
