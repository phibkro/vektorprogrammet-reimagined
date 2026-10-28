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
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Order,
  Predicate,
  Record as Rec,
  Scope,
} from "effect";
import { cast } from "effect/Function";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { transactional } from "../src/index.ts";
import { postgresDatabase, postgresJobDatabase } from "./support/database.ts";
import { AT, slack } from "./support/fixtures.ts";
import { describeExit } from "./support/race.ts";

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
  Exit.hasDies(exit) &&
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
   * Review round 2, probe C: a sibling fiber of the outer level, with the outer proof, while a nested level is live on
   * the same connection. Its statement would go into the savepoint, which rolls back, and the sibling would be told it
   * succeeded. The check compares the proof with the innermost live level of the connection, so the sibling dies.
   */
  const siblingBesideNestedLevel = Effect.gen(function* sibling() {
    const innerOpen = yield* Deferred.make<null>();
    const siblingDone = yield* Deferred.make<null>();
    const seen = yield* Deferred.make<Exit.Exit<unknown, unknown>>();

    const nested = transactional(
      Effect.gen(function* nestedLevel() {
        yield* Deferred.succeed(innerOpen, null);
        yield* Deferred.await(siblingDone);

        return yield* Effect.fail("the nested level rolls back");
      })
    );

    const beside = Effect.gen(function* besideNested() {
      yield* Deferred.await(innerOpen);
      yield* Deferred.succeed(seen, yield* Effect.exit(enqueue("sibling")));
      yield* Deferred.succeed(siblingDone, null);
    });

    const outer = yield* Effect.exit(
      transactional(
        Effect.all([Effect.exit(nested), beside], { concurrency: 2 })
      )
    );

    return { outer, sibling: yield* Deferred.await(seen) };
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
    "the stated limit (spec 0019 R7): a context captured inside a live level and provided in another transaction is that level's own, so it is accepted and writes into the first level, while it lives",
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
