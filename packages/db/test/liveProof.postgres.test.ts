/**
 * Spec 0019: the proof of a transaction is the live transaction's own. `InTransaction` is an ordinary service that Effect
 * keys by a string, so a program can make a value of it without naming it; the adapter of every method that requires it
 * checks, before its first statement, that the proof the program holds is the one that the transaction it runs in made
 * (`live.ts`), and dies as `TransactionNotLive` otherwise.
 *
 * - Falsifier 1: each forgery of the review rounds of spec 0018, outside any transaction and inside a live one, dies and
 *   writes nothing. Controls: the same program through `Transactor.run` writes; the forged context really answers
 *   `yield* InTransaction`, so the forgery is real.
 * - Falsifier 2: every method that `TransactionModes` declares `Requires`, of every port that the layers provide, dies
 *   under a forged proof before it reads its arguments, and the sweep counts the methods it reached.
 * - Falsifier 3: a proof that left its transaction is dead after it, in the next one and beside a live one (100 rounds,
 *   two connections).
 * - Falsifier 4: a nested level has its own proof.
 * - Falsifier 5: a proof is dead after every kind of exit of its level, which a fiber that outlives the level shows:
 *   it still holds the level's context.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  AdminGrantRepository,
  AggregateLocks,
  AlumniRequests,
  AuditLog,
  CodeRepository,
  ConsentRepository,
  ContactEndpoints,
  CurrentPrincipal,
  DepartmentRepository,
  DigestLedger,
  InTransaction,
  JobRun,
  LegalHolds,
  MembershipRepository,
  AuditPrincipal,
  Outbox,
  PersonId,
  PersonRepository,
  PersonalDataStore,
  RetentionRun,
  TeamRepository,
  Transactor,
  TransactionModes,
  WelcomeLedger,
  WorkspaceAssignments,
  WorkspaceReports,
  anonymous,
} from "@vektorprogrammet/domain";
import type { Duration } from "effect";
import {
  Array as Arr,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Scope,
} from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { transactional } from "../src/index.ts";
import { verified } from "../src/live.ts";
import { postgresDatabase, postgresJobDatabase } from "./support/database.ts";
import {
  AT,
  departmentDraft,
  slack,
  slackChannel,
} from "./support/fixtures.ts";
import { describeExit } from "./support/race.ts";
import { twoPeople, world } from "./support/teamsWorld.ts";

type Proof = InTransaction["Service"];

/** A proof as a forger writes it: the shape of the real one, which nothing of this module made. */
const FORGED: Proof = { kind: "database-transaction" };

/** The program of the forgeries: a write with no token, which commits one outbox row when it is allowed. */
const enqueue = Effect.fnUntraced(function* enqueue(text: string) {
  const outbox = yield* Outbox;

  return yield* outbox.enqueue([slack(text)]);
});

/** The rows of the outbox: a forgery that was refused wrote none. */
const outboxRows = Effect.gen(function* outboxRows() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly n: number;
  }>`select count(*)::int as n from outbox`;

  return rows[0]?.n ?? -1;
});

/** One write that requires the proof, with the rows it leaves: a forgery that was refused wrote none. */
interface Writer {
  readonly rows: Effect.Effect<number, SqlError, SqlClient>;
  readonly write: (text: string) => NeedsProof<unknown>;
}

const auditRows = Effect.gen(function* auditRows() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly n: number;
  }>`select count(*)::int as n from audit_log`;

  return rows[0]?.n ?? -1;
});

const WRITERS = {
  "AuditLog.record": {
    rows: auditRows,
    write: (text) =>
      Effect.flatMap(Effect.service(AuditLog), (log) =>
        log.record({
          action: "department.created",
          at: AT,
          client: "browser",
          entity: "Department",
          entityKey: text,
          principal: AuditPrincipal.cases.Person.make({
            personId: PersonId.make(7),
          }),
          sessionId: null,
        })
      ),
  },
  "Outbox.enqueue": { rows: outboxRows, write: enqueue },
} satisfies Readonly<Record<string, Writer>>;

/** Whether the exit is a defect that says the proof was not the live one. */
const refused = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  Cause.hasDies(exit.cause) &&
  Predicate.isTagged("TransactionNotLive")(Cause.squash(exit.cause));

const assertRefused = (exit: Exit.Exit<unknown, unknown>, label: string) => {
  assert.isTrue(refused(exit), `${label}: ${describeExit(exit)}`);
};

/** What the forgeries run against: a port that a program of the store's reaches, `Outbox` or `AuditLog`. */
type Ports = Outbox | AuditLog;

/** A program that needs the proof, as a forger sees it: it runs once the forger has put a proof in its context. */
type NeedsProof<A> = Effect.Effect<A, never, InTransaction | Ports>;

interface Forgery {
  /** Gives the program a proof by a way that names nothing of the domain's. */
  readonly provide: <A>(
    program: NeedsProof<A>
  ) => Effect.Effect<A, never, Ports>;
  /** Whether the forged context answers `yield* InTransaction` (round 3: it does, which is what made it a forgery). */
  readonly answers: boolean;
}

const KEY = InTransaction.key;

/** A hand-made object that `yield*` reads as a value, with no service lookup: a plain generator. */
const plainGenerator = {
  *[Symbol.iterator]() {
    yield* [];

    return FORGED;
  },
};

const FORGERIES = {
  "Context.addUnsafe with the key string, then Layer.succeedContext": {
    answers: true,
    provide: (program) =>
      Effect.provide(
        program,
        Layer.succeedContext(
          Context.addUnsafe<never, InTransaction, Proof>(
            Context.empty(),
            KEY,
            FORGED
          )
        )
      ),
  },
  "Context.makeUnsafe with the key string": {
    answers: true,
    provide: (program) =>
      Effect.provideContext(
        program,
        Context.makeUnsafe<InTransaction>(new Map([[KEY, FORGED]]))
      ),
  },
  "a cast { key } in place of the service": {
    answers: true,
    provide: (program) =>
      Effect.provideService(
        program,
        // SAFETY: this is the forgery under test (EX-0025).
        cast<{ readonly key: string }, typeof InTransaction>({ key: KEY }),
        FORGED
      ),
  },
  "a plain generator's yield* value, provided as the proof": {
    answers: true,
    provide: (program) =>
      Effect.gen(function* fromPlainGenerator() {
        const proof = yield* plainGenerator;

        return yield* Effect.provideService(program, InTransaction, proof);
      }),
  },
  "the requirement erased by a cast, nothing provided": {
    answers: false,
    provide: (program) =>
      // SAFETY: this is the forgery under test (EX-0025).
      cast(program),
  },
} satisfies Readonly<Record<string, Forgery>>;

layer(postgresDatabase({ maxConnections: 4 }), {
  excludeTestServices: true,
})("spec 0019: the proof is the live transaction's own", (it) => {
  const forgeryCases = Rec.toEntries(FORGERIES);

  const writers: readonly (readonly [string, Writer])[] = Rec.toEntries<
    string,
    Writer
  >(WRITERS);

  for (const [port, writer] of writers) {
    it.effect(
      `falsifier 1, control: ${port} through Transactor.run is accepted and commits one row`,
      () =>
        Effect.gen(function* controlWrites() {
          const before = yield* writer.rows;
          const transactor = yield* Transactor;
          yield* transactor.run(writer.write("control"));

          assert.strictEqual(yield* writer.rows, before + 1);
        })
    );
  }

  const proofMakers = Arr.filter(
    forgeryCases,
    ([, candidate]) => candidate.answers
  );

  for (const [port, writer] of writers) {
    for (const [name, forgery] of forgeryCases) {
      it.effect(
        `falsifier 1: ${name}, outside any transaction, dies as TransactionNotLive on ${port} and writes nothing`,
        () =>
          Effect.gen(function* outside() {
            const before = yield* writer.rows;

            const exit = yield* Effect.exit(
              forgery.provide(writer.write("forged"))
            );

            assertRefused(exit, name);
            assert.strictEqual(yield* writer.rows, before);
          })
      );
    }

    it.effect(
      `falsifier 1, control: a program whose requirement was erased by a cast, run inside a live transaction, inherits that transaction's own proof and ${port} is allowed`,
      () =>
        Effect.gen(function* erasedInside() {
          const before = yield* writer.rows;

          yield* transactional(
            FORGERIES[
              "the requirement erased by a cast, nothing provided"
            ].provide(writer.write("erased inside"))
          );

          assert.strictEqual(yield* writer.rows, before + 1);
        })
    );

    for (const [name, forgery] of proofMakers) {
      it.effect(
        `falsifier 1: ${name}, inside a live transaction, dies as TransactionNotLive on ${port} and the transaction writes nothing`,
        () =>
          Effect.gen(function* inside() {
            const before = yield* writer.rows;

            const exit = yield* Effect.exit(
              transactional(
                Effect.exit(
                  forgery.provide(writer.write("forged inside"))
                ).pipe(
                  Effect.flatMap((inner) =>
                    Effect.sync(() => {
                      assertRefused(inner, name);
                    })
                  )
                )
              )
            );

            assert.isTrue(Exit.isSuccess(exit), describeExit(exit));
            assert.strictEqual(yield* writer.rows, before);
          })
      );
    }
  }

  for (const [name, forgery] of proofMakers) {
    it.effect(
      `falsifier 1, control: ${name} makes a context that answers yield* InTransaction, so the forgery is real`,
      () =>
        Effect.gen(function* forgeryAnswers() {
          const proof = yield* forgery.provide(Effect.service(InTransaction));

          assert.strictEqual(proof.kind, "database-transaction");
        })
    );
  }

  it.effect(
    "falsifier 1: a structural copy of the real proof, inside its own transaction, is a forgery too",
    () =>
      Effect.gen(function* copyOfProof() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.gen(function* copied() {
            const real = yield* InTransaction;

            const exit = yield* Effect.exit(
              Effect.provideService(enqueue("copy"), InTransaction, {
                ...real,
              })
            );

            assertRefused(exit, "a copy of the live proof");
            yield* enqueue("the real proof");
          })
        );

        assert.strictEqual(yield* outboxRows, before + 1);
      })
  );

  it.effect(
    "falsifier 3: a proof returned from its transaction is dead outside any transaction and in the next one",
    () =>
      Effect.gen(function* leakedProof() {
        const transactor = yield* Transactor;
        const before = yield* outboxRows;
        const leaked = yield* transactor.run(Effect.service(InTransaction));

        const outside = yield* Effect.exit(
          Effect.provideService(enqueue("leaked"), InTransaction, leaked)
        );

        const later = yield* Effect.exit(
          transactor.run(
            Effect.provideService(
              enqueue("leaked later"),
              InTransaction,
              leaked
            )
          )
        );

        assertRefused(outside, "outside");
        assertRefused(later, "in a later transaction");
        assert.strictEqual(yield* outboxRows, before);
      })
  );

  const ROUNDS = 100;

  it.effect(
    `falsifier 3: the proof of a transaction that is still running is dead in another one (${ROUNDS} rounds, two connections), and the other one's own proof works`,
    () =>
      Effect.gen(function* beside() {
        const transactor = yield* Transactor;
        const before = yield* outboxRows;

        for (const round of Arr.range(1, ROUNDS)) {
          const proofReady = yield* Deferred.make<Proof>();
          const finish = yield* Deferred.make<null>();

          const holder = yield* transactor
            .run(
              Effect.gen(function* holding() {
                yield* Deferred.succeed(proofReady, yield* InTransaction);
                yield* Deferred.await(finish);
              })
            )
            .pipe(Effect.forkChild);

          const theirs = yield* Deferred.await(proofReady);

          const refusedHere = yield* Effect.exit(
            transactor.run(
              Effect.provideService(
                enqueue(`beside ${round}`),
                InTransaction,
                theirs
              )
            )
          );

          const ownProof = yield* Effect.exit(
            transactor.run(enqueue(`own ${round}`))
          );

          yield* Deferred.succeed(finish, null);
          yield* Fiber.join(holder);

          assertRefused(refusedHere, `round ${round}`);
          assert.isTrue(Exit.isSuccess(ownProof), describeExit(ownProof));
        }

        assert.strictEqual(yield* outboxRows, before + ROUNDS);
      }),
    { timeout: 120_000 }
  );

  /**
   * Review round 2, probe C (gated): the fiber that opened the outer level opens a nested level, and a forked child of it
   * holds the outer proof and writes while that level is live. Its statement would go into the savepoint, which rolls
   * back, and the child would be told it succeeded. The outer proof is not the innermost on the connection, so it dies.
   */
  const siblingBesideNestedLevel = Effect.gen(function* sibling() {
    const innerOpen = yield* Deferred.make<null>();
    const siblingDone = yield* Deferred.make<null>();

    const outer = yield* Effect.exit(
      transactional(
        Effect.gen(function* outerLevel() {
          const child = yield* Effect.forkChild(
            Effect.gen(function* besideNested() {
              yield* Deferred.await(innerOpen);
              const seen = yield* Effect.exit(enqueue("sibling"));
              yield* Deferred.succeed(siblingDone, null);

              return seen;
            })
          );

          yield* Effect.exit(
            transactional(
              Effect.gen(function* nestedLevel() {
                yield* Deferred.succeed(innerOpen, null);
                yield* Deferred.await(siblingDone);

                return yield* Effect.fail("the nested level rolls back");
              })
            )
          );

          return yield* Fiber.join(child);
        })
      )
    );

    return { outer, sibling: Exit.isSuccess(outer) ? outer.value : outer };
  });

  it.effect(
    "probe C: a sibling fiber of the outer level that writes while a nested level is live dies as TransactionNotLive, and the outer level still commits",
    () =>
      Effect.gen(function* siblingRefused() {
        const before = yield* outboxRows;
        const { outer, sibling } = yield* siblingBesideNestedLevel;

        assertRefused(sibling, "the outer proof while a nested level is live");
        assert.isTrue(Exit.isSuccess(outer), describeExit(outer));
        assert.strictEqual(yield* outboxRows, before);
      })
  );

  it.effect(
    "probe C, control: the same sibling after the nested level has ended writes with the outer proof and its row commits",
    () =>
      Effect.gen(function* siblingAfterNested() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            yield* Effect.exit(
              transactional(Effect.fail("the nested level rolls back"))
            );

            yield* enqueue("after the nested level");
          })
        );

        assert.strictEqual(yield* outboxRows, before + 1);
      })
  );

  it.effect(
    "the stated limit (spec 0019 R7, R14): a context captured inside a live level and provided in another transaction is that level's own, so it is accepted and writes into the first level while it lives, and commits or rolls back with it",
    () =>
      Effect.gen(function* carriedContext() {
        const transactor = yield* Transactor;
        const before = yield* outboxRows;

        const captured =
          yield* Deferred.make<Context.Context<InTransaction | Outbox>>();

        const finish = yield* Deferred.make<null>();

        const first = yield* transactor
          .run(
            Effect.gen(function* firstLevel() {
              yield* Deferred.succeed(
                captured,
                yield* Effect.context<InTransaction | Outbox>()
              );

              yield* Deferred.await(finish);

              return yield* Effect.fail("the first level rolls back");
            })
          )
          .pipe(Effect.exit, Effect.forkChild);

        const carried = yield* Deferred.await(captured);

        // The second transaction commits and says it succeeded, and the row is not there afterwards: it was written
        // into the first level, which the carried context names, and rolled back with it.
        const second = yield* Effect.exit(
          transactor.run(Effect.provideContext(enqueue("carried"), carried))
        );

        yield* Deferred.succeed(finish, null);
        yield* Fiber.join(first);

        assert.isTrue(Exit.isSuccess(second), describeExit(second));
        assert.strictEqual(yield* outboxRows, before);
      })
  );

  /**
   * Review round 3, probe E: no gate. A sibling fiber of the outer level writes with the outer proof while a nested level
   * is asked for, opened and rolled back on the same connection. In R11 the nested level entered the stack only after its
   * SAVEPOINT, so a sibling that ran while the SAVEPOINT was on the wire passed, its row went into the savepoint, and it
   * was told it succeeded. Now, in every order and delay, either the sibling dies and the nested level rolls back, or the
   * nested level dies and the sibling's row is kept: never a reported success whose row is rolled back.
   */
  const ungatedRounds = 12;

  const ungatedTimings = [
    ["0 millis", "0 millis"],
    ["0 millis", "3 millis"],
    ["3 millis", "0 millis"],
    ["0 millis", "25 millis"],
    ["10 millis", "10 millis"],
  ] as const;

  for (const [nestedAt, siblingAt] of ungatedTimings) {
    it.effect(
      `probe E (${ungatedRounds} rounds, no gate, nested level at ${nestedAt}, sibling at ${siblingAt}): the sibling dies or its row is kept, never a success that was rolled back`,
      () =>
        Effect.gen(function* ungatedSibling() {
          for (const round of Arr.range(1, ungatedRounds)) {
            const before = yield* outboxRows;

            const nested = Effect.exit(
              Effect.andThen(
                Effect.sleep(nestedAt),
                transactional(
                  Effect.andThen(
                    Effect.sleep("20 millis"),
                    Effect.fail("the nested level rolls back")
                  )
                )
              )
            );

            const sibling = Effect.exit(
              Effect.andThen(Effect.sleep(siblingAt), enqueue(`E ${round}`))
            );

            const outer = yield* Effect.exit(
              transactional(Effect.all([nested, sibling], { concurrency: 2 }))
            );

            const kept = (yield* outboxRows) - before;

            assert.isTrue(
              Exit.isSuccess(outer) &&
                (Exit.isSuccess(outer.value[1])
                  ? kept === 1
                  : refused(outer.value[1]) && kept === 0),
              `round ${round}: ${describeExit(outer)}, ${kept} rows kept`
            );
          }
        }),
      { timeout: 120_000 }
    );
  }

  it.effect(
    "probe E, the opener's side: the fiber that opened the outer level opens a nested level while a forked child of it writes with the outer proof: the child dies, the nested level's own rows are kept",
    () =>
      Effect.gen(function* ownerForksSibling() {
        const before = yield* outboxRows;

        for (const delay of ["0 millis", "10 millis"] as const) {
          yield* transactional(
            Effect.gen(function* outerLevel() {
              const child = yield* Effect.forkChild(
                Effect.exit(
                  Effect.andThen(Effect.sleep(delay), enqueue("child sibling"))
                )
              );

              yield* transactional(
                Effect.andThen(Effect.sleep("30 millis"), enqueue("nested"))
              );

              assertRefused(
                yield* Fiber.join(child),
                `a forked child of the outer level, ${delay}`
              );
            })
          );
        }

        assert.strictEqual(yield* outboxRows, before + 2);
      })
  );

  it.effect(
    "a multi-row method of the level, with a nested level asked for from a forked child while it runs: the child's level dies and every row of the method commits",
    () =>
      Effect.gen(function* methodBesideNested() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            const child = yield* Effect.forkChild(
              Effect.exit(
                transactional(Effect.fail("the nested level rolls back"))
              )
            );

            const outbox = yield* Outbox;

            yield* outbox.enqueue([
              slack("batch 1"),
              slack("batch 2"),
              slack("batch 3"),
            ]);

            assertRefused(
              yield* Fiber.join(child),
              "a nested level opened from a forked child"
            );
          })
        );

        assert.strictEqual(yield* outboxRows, before + 3);
      })
  );

  /**
   * Review round 4, probe E made deterministic. A slow statement of the outer level (not a method of a port, so it counts
   * for nothing) is already on the connection, so a nested level's SAVEPOINT waits behind it for 300 ms and a sibling that
   * starts in that time queues its INSERT behind the SAVEPOINT. The nested level is entered before its SAVEPOINT, so the
   * sibling holds a proof that is no longer the innermost and dies; entered after it, the sibling would pass, its row
   * would go into the savepoint and be rolled back while it was told it succeeded. No timing of fibers is left to chance.
   */
  it.effect(
    "probe E, deterministic: a sibling that starts while a nested level's SAVEPOINT waits on the connection dies, or its row is kept",
    () =>
      Effect.gen(function* savepointOnTheWire() {
        const sql = yield* SqlClient;
        const before = yield* outboxRows;

        const outer = yield* Effect.exit(
          transactional(
            Effect.gen(function* outerLevel() {
              const slow = yield* Effect.forkChild(sql`select pg_sleep(0.3)`);
              yield* Effect.sleep("40 millis");

              const nested = yield* Effect.forkChild(
                Effect.exit(
                  transactional(
                    Effect.andThen(
                      Effect.sleep("20 millis"),
                      Effect.fail("the nested level rolls back")
                    )
                  )
                )
              );

              yield* Effect.sleep("40 millis");

              const sibling = yield* Effect.exit(
                enqueue("behind the SAVEPOINT")
              );

              yield* Fiber.join(slow);
              yield* Fiber.join(nested);

              return sibling;
            })
          )
        );

        const kept = (yield* outboxRows) - before;

        assert.isTrue(
          Exit.isSuccess(outer) &&
            (Exit.isSuccess(outer.value)
              ? kept === 1
              : refused(outer.value) && kept === 0),
          `${describeExit(outer)}, ${kept} rows kept`
        );
      }),
    { timeout: 30_000 }
  );

  /**
   * Review round 4, P3. A fiber that outlives a nested level A holds A's context, including its proof and its
   * `[connection, 1]` pair. A nested level that it opens from there must be refused: A is gone, so its pair no longer names
   * the top of the connection's stack. Admitted, the level (Cx) would sit on the stack, the outer level would admit its
   * next nested level (B) above it, and B's row would be rolled back with Cx while B was told it succeeded.
   */
  type Fork = <A, E, R>(
    scope: Scope.Scope,
    program: Effect.Effect<A, E, R>
  ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;

  const FORKS = {
    forkChild: (_scope, program) => Effect.forkChild(program),
    forkIn: (scope, program) => Effect.forkIn(program, scope),
  } satisfies Readonly<Record<string, Fork>>;

  for (const [forkName, fork] of Rec.toEntries(FORKS)) {
    it.effect(
      `P3 (${forkName}): a fiber that outlives a nested level cannot open a level from its context, so the next nested level's row is kept`,
      () =>
        Effect.scoped(
          Effect.gen(function* survivorOpensALevel() {
            const scope = yield* Effect.scope;
            const before = yield* outboxRows;
            const start = yield* Deferred.make<null>();
            const cxOpen = yield* Deferred.make<null>();
            const bDone = yield* Deferred.make<null>();

            const outer = yield* Effect.exit(
              transactional(
                Effect.gen(function* outerLevel() {
                  const survivor = yield* transactional(
                    fork(
                      scope,
                      Effect.andThen(
                        Deferred.await(start),
                        Effect.exit(
                          transactional(
                            Effect.andThen(
                              Deferred.succeed(cxOpen, null),
                              Effect.andThen(
                                Deferred.await(bDone),
                                Effect.fail("Cx rolls back")
                              )
                            )
                          )
                        )
                      )
                    )
                  );

                  yield* Deferred.succeed(start, null);
                  yield* Effect.timeoutOption(
                    Deferred.await(cxOpen),
                    "300 millis"
                  );

                  const b = yield* Effect.exit(transactional(enqueue("B")));
                  yield* Deferred.succeed(bDone, null);

                  return { b, cx: yield* Fiber.join(survivor) };
                })
              )
            );

            const kept = (yield* outboxRows) - before;

            assert.isTrue(Exit.isSuccess(outer), describeExit(outer));

            if (Exit.isSuccess(outer)) {
              // The loss itself, first: B reported success, so its row must be kept.
              assert.isTrue(
                Exit.isSuccess(outer.value.b),
                describeExit(outer.value.b)
              );
              assert.strictEqual(
                kept,
                1,
                "B reported success, so its row must be kept"
              );
              assertRefused(
                outer.value.cx,
                "the level opened from a dead level"
              );
            }
          })
        ),
      { timeout: 30_000 }
    );
  }

  it.effect(
    "P8: a fiber that outlives a nested level that failed cannot open a level from its context: it is refused and writes nothing",
    () =>
      Effect.gen(function* survivorOfAFailedLevel() {
        const before = yield* outboxRows;

        const outer = yield* Effect.exit(
          transactional(
            Effect.gen(function* outerLevel() {
              const gate = yield* Deferred.make<null>();

              const survivor =
                yield* Deferred.make<Fiber.Fiber<Exit.Exit<unknown>>>();

              yield* Effect.exit(
                transactional(
                  Effect.gen(function* failingLevel() {
                    const fiber = yield* Effect.forkChild(
                      Effect.andThen(
                        Deferred.await(gate),
                        Effect.exit(transactional(enqueue("survivor")))
                      )
                    );

                    yield* Deferred.succeed(survivor, fiber);

                    return yield* Effect.fail("the nested level rolls back");
                  })
                )
              );

              yield* Deferred.succeed(gate, null);

              return yield* Fiber.join(yield* Deferred.await(survivor));
            })
          )
        );

        assert.isTrue(Exit.isSuccess(outer), describeExit(outer));

        if (Exit.isSuccess(outer)) {
          assertRefused(outer.value, "the survivor of a failed level");
        }

        assert.strictEqual(yield* outboxRows, before);
      })
  );

  /**
   * Review round 6: a level ends and takes with it every level above it, as the savepoint statements do. Nested level A
   * forks, into a scope that outlives the transaction, a fiber that opens level C and keeps it open. A ends over C and is
   * abandoned. The outer level is then the top of the stack again and its ordinary write must succeed and commit. A `leave`
   * that removes only its own entry leaves the closed C on top, and the outer level's write dies as `TransactionNotLive`.
   */
  it.effect(
    "a level that ends over a level of a surviving fiber is abandoned, and the outer level is the top of the stack again: its write succeeds and commits",
    () =>
      Effect.scoped(
        Effect.gen(function* truncation() {
          const scope = yield* Effect.scope;
          const before = yield* outboxRows;
          const cOpen = yield* Deferred.make<null>();
          const cGate = yield* Deferred.make<null>();

          const survivor =
            yield* Deferred.make<Fiber.Fiber<Exit.Exit<unknown>>>();

          const outer = yield* Effect.exit(
            transactional(
              Effect.gen(function* outerLevel() {
                const a = yield* Effect.exit(
                  transactional(
                    Effect.gen(function* levelA() {
                      const fiber = yield* Effect.forkIn(
                        Effect.exit(
                          transactional(
                            Effect.andThen(
                              Deferred.succeed(cOpen, null),
                              Deferred.await(cGate)
                            )
                          )
                        ),
                        scope
                      );

                      yield* Deferred.succeed(survivor, fiber);
                      yield* Deferred.await(cOpen);
                    })
                  )
                );

                assertRefused(
                  a,
                  "level A ended over a level that is still open"
                );

                return yield* Effect.exit(enqueue("after A"));
              })
            )
          );

          // C ends after the transaction has, with its connection released: that is C's own failure, not the outer level's.
          yield* Deferred.succeed(cGate, null);
          yield* Fiber.join(yield* Deferred.await(survivor));

          assert.isTrue(Exit.isSuccess(outer), describeExit(outer));

          if (Exit.isSuccess(outer)) {
            assert.isTrue(
              Exit.isSuccess(outer.value),
              describeExit(outer.value)
            );
          }

          assert.strictEqual(yield* outboxRows, before + 1);
        })
      )
  );

  /**
   * Review round 4, P9: the proof conjunct of the admission of a nested level. A fiber that outlives nested level A holds
   * A's `[connection, 1]` pair. While the outer level's next nested level B is live, idle and the top of the stack, the
   * depth and the length both pass for that fiber, and only the proof it holds (A's, not B's) refuses it. Admitted, its
   * level Cx would sit on B, report success, and be rolled back with B.
   */
  it.effect(
    "P9: a fiber that outlives a nested level cannot open a level above the outer level's next nested level, which is live and idle: it is refused and writes nothing",
    () =>
      Effect.gen(function* survivorAboveAnIdleLevel() {
        const before = yield* outboxRows;
        const bIsLive = yield* Deferred.make<null>();

        const survivors =
          yield* Deferred.make<Fiber.Fiber<Exit.Exit<unknown>>>();

        // Level A forks the survivor and ends; level B then waits for the survivor's attempt at a level of its own.
        const levelA = transactional(
          Effect.flatMap(
            Effect.forkChild(
              Effect.andThen(
                Deferred.await(bIsLive),
                Effect.exit(transactional(enqueue("Cx")))
              )
            ),
            (fiber) => Deferred.succeed(survivors, fiber)
          )
        );

        const levelB = transactional(
          Effect.andThen(
            Deferred.succeed(bIsLive, null),
            Effect.flatMap(Deferred.await(survivors), Fiber.join)
          )
        );

        const outer = yield* Effect.exit(
          transactional(Effect.andThen(levelA, Effect.exit(levelB)))
        );

        assert.isTrue(Exit.isSuccess(outer), describeExit(outer));

        if (Exit.isSuccess(outer) && Exit.isSuccess(outer.value)) {
          assertRefused(
            outer.value.value,
            "the level opened from a dead level"
          );
        }

        // B commits here, so a Cx that was admitted would have left its row.
        const kept = (yield* outboxRows) - before;

        assert.strictEqual(kept, 0, "Cx was refused, so it wrote nothing");
      })
  );

  it.effect(
    "two nested levels asked for at once from one parent: the second is refused as TransactionNotLive every time, and the first completes with its row (30 rounds)",
    () =>
      Effect.gen(function* twoAtOnce() {
        for (const round of Arr.range(1, 30)) {
          const before = yield* outboxRows;

          const [first, second] = yield* transactional(
            Effect.all(
              [
                Effect.exit(transactional(enqueue(`first ${round}`))),
                Effect.exit(transactional(enqueue(`second ${round}`))),
              ],
              { concurrency: 2 }
            )
          );

          assert.isTrue(
            Exit.isSuccess(first),
            `round ${round}: first ${describeExit(first)}`
          );

          assertRefused(second, `round ${round}: the second of two at once`);
          assert.strictEqual((yield* outboxRows) - before, 1, `round ${round}`);
        }
      }),
    { timeout: 60_000 }
  );

  /**
   * The invariant of spec 0019 R14: for every interleaving of a method of a level and a nested level on one connection,
   * one of them dies as `TransactionNotLive`, or both complete and every row is in the level that reported it. This
   * method has two statements with a gap between them, so a `SAVEPOINT` that lands in the gap would take the second
   * statement into the savepoint.
   */
  const twoStatementOutbox = Effect.gen(function* twoStatementOutbox() {
    const sql = yield* SqlClient;

    return yield* verified(
      "Outbox",
      Outbox.of({
        enqueue: () =>
          Effect.gen(function* twoStatements() {
            yield* sql`insert into probe_rows (n) values (1)`;
            yield* Effect.sleep("15 millis");
            yield* sql`insert into probe_rows (n) values (2)`;

            return [];
          }).pipe(Effect.orDie),
      })
    );
  });

  const probeRows = Effect.gen(function* probeRows() {
    const sql = yield* SqlClient;

    const rows = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from probe_rows`;

    return rows[0]?.n ?? -1;
  });

  /** One round: the method and a nested level, started at the given delays; says what went wrong, or nothing. */
  const twoStatementRound = (
    outbox: Outbox["Service"],
    nestedAt: Duration.Input,
    methodAt: Duration.Input
  ) =>
    Effect.gen(function* round() {
      const sql = yield* SqlClient;
      yield* sql`delete from probe_rows`;

      const method = Effect.exit(
        Effect.andThen(
          Effect.sleep(methodAt),
          outbox.enqueue([slack("two statements")])
        )
      );

      const nested = Effect.exit(
        Effect.andThen(
          Effect.sleep(nestedAt),
          transactional(
            Effect.andThen(
              Effect.sleep("30 millis"),
              Effect.fail("the nested level rolls back")
            )
          )
        )
      );

      const [methodExit] = yield* Effect.all([method, nested], {
        concurrency: 2,
      });

      const rows = yield* probeRows;

      const holds = Exit.isSuccess(methodExit)
        ? rows === 2
        : refused(methodExit) && rows === 0;

      return holds
        ? ""
        : `the method ${describeExit(methodExit)} and ${rows} rows are in the level`;
    });

  it.effect(
    "the multi-statement case: a two-statement method beside a nested level that is asked for in the gap between its statements, in every order and delay: the nested level dies, or both complete and the method's two rows are kept",
    () =>
      Effect.gen(function* methodBesideSavepoint() {
        const outbox = yield* twoStatementOutbox;
        const sql = yield* SqlClient;

        const timings = [
          ["0 millis", "0 millis"],
          ["0 millis", "4 millis"],
          ["4 millis", "0 millis"],
          ["8 millis", "0 millis"],
          ["30 millis", "0 millis"],
        ] as const;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            yield* sql`create temp table probe_rows (n int) on commit drop`;

            for (const [nestedAt, methodAt] of timings) {
              const outcomes = yield* Effect.forEach(Arr.range(1, 8), () =>
                twoStatementRound(outbox, nestedAt, methodAt)
              );

              assert.deepStrictEqual(
                Arr.filter(outcomes, (outcome) => outcome !== ""),
                [],
                `nested at ${nestedAt}, method at ${methodAt}`
              );
            }
          })
        );
      }),
    { timeout: 120_000 }
  );

  it.effect(
    "a command dispatched through the in-process RPC server, which runs its handler on a fiber of its own, passes inside Transactor.run and commits its rows",
    () =>
      Effect.gen(function* rpcDispatched() {
        const transactor = yield* Transactor;

        const department = yield* (yield* DepartmentRepository).create(
          departmentDraft("Rpcby", {
            slackChannel: slackChannel("avdeling-rpcby"),
          })
        );

        const before = yield* outboxRows;

        const receipt = yield* transactor.run(
          ContactEndpoints.submitContact({
            departmentId: department.id,
            email: "rpc@innsender.example",
            message: "Hei",
            name: "Testperson",
            subject: "Spørsmål",
          }).pipe(Effect.provideService(CurrentPrincipal, anonymous))
        );

        assert.isAbove(receipt.messageIds.length, 0);
        assert.strictEqual(
          yield* outboxRows,
          before + receipt.messageIds.length
        );
      })
  );

  it.effect(
    "concurrent methods of one level pass: five enqueues at once inside one transaction all commit",
    () =>
      Effect.gen(function* concurrentSameLevel() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.all(
            Arr.map(Arr.range(1, 5), (n) => enqueue(`concurrent ${n}`)),
            { concurrency: 5 }
          )
        );

        assert.strictEqual(yield* outboxRows, before + 5);
      })
  );

  it.effect(
    "a method interrupted while it runs leaves its level admitting a nested level again: the count is released on interruption",
    () =>
      Effect.gen(function* interruptedMethod() {
        const { fieldOfStudy } = yield* world("interrupted");
        const [person] = yield* twoPeople(fieldOfStudy.id, "interrupted");
        const holding = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();

        const holder = yield* transactional(
          Effect.gen(function* holdTheRow() {
            yield* AggregateLocks.use((locks) =>
              locks.lock("Person", person.id)
            );

            yield* Deferred.succeed(holding, null);
            yield* Deferred.await(release);
          })
        ).pipe(Effect.forkChild);

        yield* Deferred.await(holding);

        yield* transactional(
          Effect.gen(function* levelWithABlockedMethod() {
            const blocked = yield* Effect.forkChild(
              AggregateLocks.use((locks) => locks.lock("Person", person.id))
            );

            yield* Effect.sleep("100 millis");

            // A nested level that is not refused queues its SAVEPOINT behind the blocked method on the connection, so
            // its answer is read from a fiber with a bound, never waited for: a mutant fails here instead of hanging.
            const attempt = yield* Effect.forkChild(
              Effect.exit(transactional(Effect.void))
            );

            const answer = yield* Effect.timeoutOption(
              Fiber.join(attempt),
              "2 seconds"
            );

            const interrupting = yield* Effect.forkChild(
              Fiber.interrupt(blocked)
            );

            yield* Deferred.succeed(release, null);
            yield* Fiber.join(holder);
            yield* Fiber.join(interrupting);
            yield* Fiber.interrupt(attempt);

            const nested = yield* Effect.exit(transactional(Effect.void));
            assert.isTrue(Exit.isSuccess(nested), describeExit(nested));

            assert.isTrue(
              Option.isSome(answer) && refused(answer.value),
              `a nested level asked for while a method of the level around it is blocked in the database: ${Option.isSome(answer) ? describeExit(answer.value) : "not refused within 2 seconds"}`
            );
          })
        );
      }),
    { timeout: 60_000 }
  );

  it.effect(
    "production patterns (forEach and all without concurrency, exit and retry around nested levels) all commit",
    () =>
      Effect.gen(function* productionPatterns() {
        const before = yield* outboxRows;
        let attempts = 0;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            yield* Effect.forEach(
              Arr.range(1, 3),
              (n) => transactional(enqueue(`forEach ${n}`)),
              { concurrency: 1 }
            );

            yield* Effect.all([
              enqueue("all 1"),
              transactional(enqueue("all 2")),
            ]);

            yield* Effect.exit(
              transactional(
                Effect.andThen(enqueue("rolled back"), Effect.fail("no"))
              )
            );

            yield* Effect.retry(
              transactional(
                Effect.suspend(() => {
                  attempts += 1;

                  return attempts < 3
                    ? Effect.fail("again")
                    : enqueue("retried");
                })
              ),
              { times: 5 }
            );

            yield* enqueue("outer after");
          })
        );

        assert.strictEqual(attempts, 3);
        // three forEach rows, two from all, the retried one, and the outer's: 7
        assert.strictEqual(yield* outboxRows, before + 7);
      })
  );

  it.effect(
    "falsifier 4: a nested level has its own proof: the outer one does not pass inside it, the inner one does not pass after it",
    () =>
      Effect.gen(function* nestedLevels() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            const outer = yield* InTransaction;

            const inner = yield* transactional(
              Effect.gen(function* innerLevel() {
                const own = yield* InTransaction;
                assert.notStrictEqual(own, outer);

                yield* enqueue("inner with the inner proof");

                assertRefused(
                  yield* Effect.exit(
                    Effect.provideService(
                      enqueue("inner with the outer proof"),
                      InTransaction,
                      outer
                    )
                  ),
                  "the outer proof inside the inner level"
                );

                return own;
              })
            );

            assertRefused(
              yield* Effect.exit(
                Effect.provideService(
                  enqueue("outer with the inner proof"),
                  InTransaction,
                  inner
                )
              ),
              "the inner proof after its level"
            );

            yield* enqueue("outer with the outer proof");
          })
        );

        assert.strictEqual(yield* outboxRows, before + 2);
      })
  );

  it.effect(
    "falsifier 4: a nested level that fails leaves its proof dead, and the outer level still holds its own",
    () =>
      Effect.gen(function* failedInnerLevel() {
        const before = yield* outboxRows;

        yield* transactional(
          Effect.gen(function* outerLevel() {
            const captured = yield* Deferred.make<Proof>();

            const failed = yield* Effect.exit(
              transactional(
                Effect.gen(function* innerLevel() {
                  yield* Deferred.succeed(captured, yield* InTransaction);
                  yield* enqueue("rolled back with its level");

                  return yield* Effect.die("the inner level fails");
                })
              )
            );

            assert.isTrue(Exit.hasDies(failed));

            assertRefused(
              yield* Effect.exit(
                Effect.provideService(
                  enqueue("with the dead inner proof"),
                  InTransaction,
                  yield* Deferred.await(captured)
                )
              ),
              "the proof of a level that failed"
            );

            yield* enqueue("outer");
          })
        );

        assert.strictEqual(yield* outboxRows, before + 1);
      })
  );

  /**
   * A fiber that a level forks into a scope that outlives it keeps the level's context, proof included. After the level
   * has ended, by each kind of exit, what it asks of the store must be refused: the entry of the level is gone, and the
   * connection it named is back in the pool.
   */
  type Level = Effect.Effect<void, never, InTransaction | Outbox>;

  const exitsOfALevel = {
    "a commit": (level: Level) => transactional(level),
    "a defect": (level: Level) =>
      Effect.exit(
        transactional(Effect.andThen(level, Effect.die("the level fails")))
      ),
    "a typed failure": (level: Level) =>
      Effect.exit(
        transactional(Effect.andThen(level, Effect.fail("the level fails")))
      ),
    "an interruption": (level: Level) =>
      Effect.gen(function* interrupted() {
        const started = yield* Deferred.make<null>();

        const fiber = yield* transactional(
          Effect.andThen(
            level,
            Effect.andThen(Deferred.succeed(started, null), Effect.never)
          )
        ).pipe(Effect.forkChild);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      }),
  } as const;

  for (const [exitName, endLevel] of Rec.toEntries(exitsOfALevel)) {
    it.effect(
      `falsifier 5: a fiber that outlives its level cannot use the level's proof after ${exitName}`,
      () =>
        Effect.gen(function* outlivesTheLevel() {
          const scope = yield* Scope.make();
          const gate = yield* Deferred.make<null>();
          const before = yield* outboxRows;

          const survivor =
            yield* Deferred.make<Fiber.Fiber<Exit.Exit<unknown>>>();

          yield* endLevel(
            Effect.gen(function* forkSurvivor() {
              const fiber = yield* Effect.forkIn(
                Effect.andThen(
                  Deferred.await(gate),
                  Effect.exit(enqueue("after the level"))
                ),
                scope
              );

              yield* Deferred.succeed(survivor, fiber);
            })
          );

          const fiber = yield* Deferred.await(survivor);
          yield* Deferred.succeed(gate, null);

          // The survivor's own program caught its exit: a defect of this tag, not a write.
          assertRefused(yield* Fiber.join(fiber), `after ${exitName}`);

          yield* Scope.close(scope, Exit.void);
          assert.strictEqual(yield* outboxRows, before);
        })
    );
  }
});

/** The ports of the declaration that have a `Requires` method, by name, each with the class that the layers provide. */
const PORTS = {
  AccountRepository,
  AdminGrantRepository,
  AggregateLocks,
  AlumniRequests,
  AuditLog,
  CodeRepository,
  ConsentRepository,
  DigestLedger,
  JobRuns: JobRun.JobRuns,
  LegalHolds,
  MembershipRepository,
  Outbox,
  PersonRepository,
  PersonalDataStore,
  RetentionRun,
  TeamRepository,
  WelcomeLedger,
  WorkspaceAssignments,
  WorkspaceReports,
} as const;

/** The declaration as plain data: the mode of each method of each port, by name. */
const modesByPort: Readonly<Record<string, Readonly<Record<string, string>>>> =
  TransactionModes;

/** The `Requires` methods of a port, from the declaration. */
const requiresOf = (port: string): readonly string[] =>
  Arr.filter(
    Rec.keys(modesByPort[port] ?? {}),
    (method) => modesByPort[port]?.[method] === "Requires"
  );

const declaredPorts = Arr.filter(
  Rec.keys(modesByPort),
  (port) => requiresOf(port).length > 0
);

type PortName = keyof typeof PORTS;

const isHeldPort = (port: string): port is PortName => port in PORTS;

/** A port as the sweep calls it: each method by name, with no arguments. */
type PortMethods = Readonly<
  Record<string, () => Effect.Effect<unknown, never, InTransaction>>
>;

/** The program of one method called with no arguments (a verified one never reads them), under a forged proof, run to its exit. */
const underForgedProof = (service: PortMethods, method: string) =>
  Effect.exit(
    Effect.provideService(
      Effect.suspend(
        () => service[method]?.() ?? Effect.die(`${method} is not a method`)
      ),
      InTransaction,
      FORGED
    )
  );

/** Each `Requires` method of the ports, called under a forged proof outside a transaction and inside a live one. */
const sweep = (ports: readonly PortName[]) =>
  Effect.gen(function* sweepPorts() {
    const reached: string[] = [];

    for (const port of ports) {
      // SAFETY: the declaration says that each method that the sweep calls requires `InTransaction` and returns an effect (EX-0025).
      const service = cast<unknown, PortMethods>(yield* PORTS[port]);

      for (const method of requiresOf(port)) {
        const outside = yield* underForgedProof(service, method);
        assertRefused(outside, `${port}.${method} outside a transaction`);

        const inside = yield* transactional(underForgedProof(service, method));
        assertRefused(inside, `${port}.${method} inside a live transaction`);
        reached.push(`${port}.${method}`);
      }
    }

    return reached;
  });

const expectedMethods = (ports: readonly PortName[]) =>
  Arr.flatMap(ports, (port) =>
    Arr.map(requiresOf(port), (method) => `${port}.${method}`)
  );

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0019: no Requires method of a port that DatabaseLive provides escapes the check",
  (it) => {
    it.effect(
      "falsifier 2: the ports of the declaration with a Requires method are the ports this test holds",
      () =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            Arr.sort(declaredPorts, Order.String),
            Arr.sort(Rec.keys(PORTS), Order.String)
          );
        })
    );

    it.effect(
      "falsifier 2: every Requires method of the declaration, under a forged proof, dies as TransactionNotLive before it reads its arguments",
      () =>
        Effect.gen(function* everyMethod() {
          const ports = Arr.filter(
            Arr.filter(declaredPorts, isHeldPort),
            (port) => port !== "RetentionRun"
          );

          const reached = yield* sweep(ports);

          // The sweep counts what it reached, so a method that it skipped is a count short.
          assert.deepStrictEqual(reached, expectedMethods(ports));
          assert.isAbove(reached.length, 0);
        })
    );

    it.effect(
      "falsifier 2: the nightly run that only counts verifies too",
      () =>
        Effect.gen(function* reportingRun() {
          assert.deepStrictEqual(yield* sweep(["RetentionRun"]), [
            "RetentionRun.run",
          ]);
        })
    );
  }
);

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0019: the run that applies verifies",
  (it) => {
    it.effect(
      "falsifier 2: the nightly run that changes rows dies under a forged proof before it takes a lock",
      () =>
        Effect.gen(function* applyingRun() {
          assert.deepStrictEqual(yield* sweep(["RetentionRun"]), [
            "RetentionRun.run",
          ]);
        })
    );
  }
);
