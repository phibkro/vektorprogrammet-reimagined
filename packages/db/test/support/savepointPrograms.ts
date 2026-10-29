/**
 * Generated programs over one connection, for the property test of spec 0019 R21 (`liveProperty.postgres.test.ts`).
 *
 * A program is a tree of steps run inside one `transactional` level:
 *
 * - `Write`: `Outbox.enqueue` of a row with a unique label, in the level that the step runs in;
 * - `Sleep`: a short delay, so that fibers interleave in many orders;
 * - `Level`: a nested `transactional` that ends by commit, a typed failure, a defect, an interruption of its own fiber, or
 *   a timeout (which runs the level on a forked fiber and interrupts it);
 * - `Fork`: a fiber started in the context of the level, by `forkChild` (interrupted when the level's fiber ends), `forkIn`
 *   (a scope that outlives the transaction) or `forkDetach`, which runs the body after a delay;
 * - `Par`: the branches run at once on fibers of their own, in the level (concurrent methods, and levels asked for at
 *   once).
 *
 * The oracle needs no model of PostgreSQL. Every write records the level whose proof it held, and every level records
 * whether it reported success. A write that reported success must be in the final committed state if and only if its
 * level and every level around it reported success; a write that was refused must not be there at all; a write that was
 * interrupted may be there only if its levels reported success.
 */
import { Outbox } from "@vektorprogrammet/domain";
import type { InTransaction } from "@vektorprogrammet/domain";
import type { Scope } from "effect";
import {
  Arbitrary,
  Array as Arr,
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Predicate,
  Schema,
  Tracer,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../../src/index.ts";
import { slack } from "./fixtures.ts";

type Ending = "commit" | "fail" | "die" | "interrupt" | "timeout";

type ForkKind = "child" | "in" | "detach";

interface WriteStep {
  readonly _tag: "Write";
}

interface SleepStep {
  readonly _tag: "Sleep";
  readonly ms: number;
}

interface LevelStep {
  readonly _tag: "Level";
  readonly body: Body;
  readonly ending: Ending;
}

interface ForkStep {
  readonly _tag: "Fork";
  readonly body: Body;
  readonly delay: number;
  readonly kind: ForkKind;
}

interface ParStep {
  readonly _tag: "Par";
  readonly branches: readonly Body[];
}

/** A statement that holds the connection for a while and is not a method of a port: the closing statement queues behind it. */
interface SlowStep {
  readonly _tag: "Slow";
  readonly ms: number;
}

/** A level that commits, run under a deadline that interrupts it. */
interface BoundedStep {
  readonly _tag: "Bounded";
  readonly body: Body;
  readonly ms: number;
}

/** Steps one after the other in the level: how a generator makes a pattern of two levels. */
interface SeqStep {
  readonly _tag: "Seq";
  readonly steps: Body;
}

type Step =
  | WriteStep
  | SleepStep
  | LevelStep
  | ForkStep
  | ParStep
  | SeqStep
  | SlowStep
  | BoundedStep;

export type Body = readonly Step[];

/** The outermost level, with the way it ends. */
export interface Program {
  readonly body: Body;
  readonly ending: Ending;
}

const steps = Data.taggedEnum<Step>();

// ---- generation ------------------------------------------------------------------------------------------------

const integer = (maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum, minimum: 0 })));

/** One of `table`, in the proportions that the table repeats its members. */
const oneOf = <A>(table: readonly [A, ...A[]]): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(integer(table.length - 1), (index) => table[index] ?? table[0]);

const ENDINGS: readonly [Ending, ...Ending[]] = [
  "commit",
  "commit",
  "fail",
  "die",
  "interrupt",
  "timeout",
];

const ROOT_ENDINGS: readonly [Ending, ...Ending[]] = [
  "commit",
  "commit",
  "commit",
  "commit",
  "commit",
  "commit",
  "fail",
  "die",
  "interrupt",
  "timeout",
];

const FORKS: readonly [ForkKind, ...ForkKind[]] = [
  "child",
  "in",
  "detach",
  "detach",
];

/** How many levels deep the generator goes below the outermost one. */
const DEPTH = 4;

const stepsAt = (depth: number): Arbitrary.Arbitrary<Step> => {
  const write: Arbitrary.Arbitrary<Step> = Arbitrary.Constant(steps.Write());

  const sleep: Arbitrary.Arbitrary<Step> = Arbitrary.map(integer(6), (ms) =>
    steps.Sleep({ ms })
  );

  if (depth === 0) {
    return Arbitrary.flatMap(integer(3), (index) =>
      index < 3 ? write : sleep
    );
  }

  const below = stepsAt(depth - 1);

  const body = Arbitrary.array(below, { maxLength: 4, minLength: 1 });

  const level = Arbitrary.map(
    Arbitrary.all({ body, ending: oneOf(ENDINGS) }),
    (parts) => steps.Level(parts)
  );

  const fork = Arbitrary.map(
    Arbitrary.all({ body, delay: integer(8), kind: oneOf(FORKS) }),
    (parts) => steps.Fork(parts)
  );

  const par = Arbitrary.map(
    Arbitrary.array(body, { maxLength: 3, minLength: 2 }),
    (branches) => steps.Par({ branches })
  );

  // The survivor pattern of the review rounds: a level whose fiber outlives it, then a later level that is live while the
  // survivor acts with the dead level's context.
  const survivor = Arbitrary.map(
    Arbitrary.all({
      delay: integer(8),
      ending: oneOf(ENDINGS),
      gap: body,
      inner: body,
      kind: oneOf(FORKS),
    }),
    ({ delay, ending, gap, inner, kind }) =>
      steps.Seq({
        steps: [
          steps.Level({
            body: [steps.Fork({ body: inner, delay, kind })],
            ending: "commit",
          }),
          steps.Level({ body: gap, ending }),
        ],
      })
  );

  const table = [
    write,
    write,
    sleep,
    sleep,
    level,
    level,
    level,
    fork,
    fork,
    par,
    survivor,
    survivor,
  ] as const;

  return Arbitrary.flatMap(
    integer(table.length - 1),
    (index) => table[index] ?? write
  );
};

/** The generator: a root body of up to four steps, each of which may open levels `DEPTH` deep. */
export const programs: Arbitrary.Arbitrary<Program> = Arbitrary.all({
  body: Arbitrary.array(stepsAt(DEPTH), { maxLength: 4, minLength: 1 }),
  ending: oneOf(ROOT_ENDINGS),
});

// ---- running ---------------------------------------------------------------------------------------------------

/** The parent of the outermost level. */
const NO_LEVEL = -1;

/** The events that `withTransaction` records on its span when the body has succeeded, before it sends `RELEASE` or `COMMIT`. */
const COMMIT_EVENTS = [
  "effect.sql.transaction.commit",
  "effect.sql.transaction.savepoint",
];

/** Whether the level's transaction span says that its closing statement was issued by the success path. */
const statementIssued = (span: Tracer.Span | undefined) =>
  span instanceof Tracer.NativeSpan &&
  Arr.some(span.events, ([name]) => Arr.contains(COMMIT_EVENTS, name));

interface LevelRecord {
  committed: boolean;
  readonly parent: number;
  /** Its body ended and it was to commit. */
  reachedCommit: boolean;
  /** The span of its transaction, where the closing statement is recorded. */
  span: Tracer.Span | undefined;
  /** It reached its commit, its closing statement was issued, and it was interrupted: it has merged. */
  mergedAfterInterrupt: boolean;
}

type Outcome = "pending" | "ok" | "refused" | "other";

interface WriteRecord {
  readonly label: string;
  readonly level: number;
  outcome: Outcome;
}

interface Ledger {
  /** What happened in what order, with the time in milliseconds, for the report of a violation. */
  readonly events: string[];
  readonly fibers: Fiber.Fiber<void>[];
  readonly levels: LevelRecord[];
  readonly prefix: string;
  readonly scope: Scope.Scope;
  readonly writes: WriteRecord[];
}

const note = (ledger: Ledger, text: string) => {
  ledger.events.push(`${performance.now().toFixed(2)} ${text}`);
};

type Needs = InTransaction | Outbox | SqlClient;

/** Whether the exit is a defect that says the proof was not the live one. */
const refusedExit = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  Cause.hasDies(exit.cause) &&
  Predicate.isTagged("TransactionNotLive")(Cause.squash(exit.cause));

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) {
    return "ok";
  }

  return refusedExit(exit) ? "refused" : "other";
};

const write = (
  ledger: Ledger,
  level: number
): Effect.Effect<void, never, Needs> =>
  Effect.suspend(() => {
    const record: WriteRecord = {
      label: `${ledger.prefix}${ledger.writes.length}`,
      level,
      outcome: "pending",
    };

    ledger.writes.push(record);
    note(ledger, `${record.label} start in L${level}`);

    return Effect.flatMap(Outbox, (outbox) =>
      outbox.enqueue([slack(record.label)])
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          record.outcome = outcomeOf(exit);
          note(ledger, `${record.label} ${record.outcome}`);
        })
      ),
      Effect.exit,
      Effect.asVoid
    );
  });

const FORKERS = {
  child: (effect: Effect.Effect<void, never, Needs>) =>
    Effect.forkChild(effect),
  detach: (effect: Effect.Effect<void, never, Needs>) =>
    Effect.forkDetach(effect),
  in: (effect: Effect.Effect<void, never, Needs>, scope: Scope.Scope) =>
    Effect.forkIn(effect, scope),
} as const;

const endWith = (ending: Ending): Effect.Effect<void, string> => {
  const endings = {
    commit: Effect.void,
    die: Effect.die("the level fails with a defect"),
    fail: Effect.fail("the level fails"),
    interrupt: Effect.interrupt,
    timeout: Effect.never,
  } as const;

  return endings[ending];
};

type RunBody = (level: number, body: Body) => Effect.Effect<void, never, Needs>;

/** The body of a level, step by step, in the level; `step` is how one step runs. */
const bodyRunner =
  (
    step: (level: number, one: Step) => Effect.Effect<void, never, Needs>
  ): RunBody =>
  (level, body) =>
    Effect.forEach(body, (one) => step(level, one), { discard: true });

/** One level, entered in the ledger when it runs: its steps, then its ending, with its exit recorded however it ends. */
const levelOf = (
  ledger: Ledger,
  runBody: RunBody,
  parent: number,
  ending: Ending,
  body: Body,
  bound: Option.Option<Duration.Duration>
): Effect.Effect<void, never, Outbox | SqlClient> =>
  Effect.suspend(() => {
    const id = ledger.levels.length;

    const record: LevelRecord = {
      committed: false,
      mergedAfterInterrupt: false,
      parent,
      reachedCommit: false,
      span: undefined,
    };

    ledger.levels.push(record);

    note(ledger, `L${id} open (parent ${parent}, ends by ${ending})`);

    const level = Effect.onExit(
      transactional(
        Effect.andThen(
          Effect.andThen(
            Effect.flatMap(Effect.option(Effect.currentSpan), (span) => {
              record.span = Option.getOrUndefined(span);

              return runBody(id, body);
            }),
            Effect.sync(() => {
              record.reachedCommit = ending === "commit";
              note(ledger, `L${id} body ended`);
            })
          ),
          endWith(ending)
        )
      ),
      (exit) =>
        Effect.sync(() => {
          const issued = statementIssued(record.span);
          record.committed = Exit.isSuccess(exit);
          record.mergedAfterInterrupt =
            record.reachedCommit &&
            Exit.isFailure(exit) &&
            Cause.hasInterruptsOnly(exit.cause) &&
            issued;
          note(
            ledger,
            `L${id} exit ${Exit.isSuccess(exit) ? "success" : "failure"}, commit statement issued: ${issued}${record.mergedAfterInterrupt ? " (interrupted at its commit)" : ""}`
          );
        })
    );

    return Effect.asVoid(
      Effect.exit(
        Option.match(bound, {
          onNone: () => level,
          onSome: (duration) => Effect.timeout(level, duration),
        })
      )
    );
  });

/** A level that ends by timeout runs under a deadline of 12 ms, which interrupts it. */
const boundOf = (ending: Ending) =>
  ending === "timeout"
    ? Option.some(Duration.millis(12))
    : Option.none<Duration.Duration>();

const runStep = (
  ledger: Ledger,
  level: number,
  step: Step
): Effect.Effect<void, never, Needs> => {
  const runBody = bodyRunner((inLevel, one) => runStep(ledger, inLevel, one));

  return steps.$match(step, {
    Bounded: ({ body, ms }) =>
      levelOf(
        ledger,
        runBody,
        level,
        "commit",
        body,
        Option.some(Duration.millis(ms))
      ),
    Fork: ({ body, delay, kind }) =>
      Effect.flatMap(
        FORKERS[kind](
          Effect.andThen(
            Effect.sleep(Duration.millis(delay)),
            runBody(level, body)
          ),
          ledger.scope
        ),
        (fiber) =>
          Effect.sync(() => {
            ledger.fibers.push(fiber);
          })
      ),
    Level: ({ body, ending }) =>
      levelOf(ledger, runBody, level, ending, body, boundOf(ending)),
    Par: ({ branches }) =>
      Effect.forEach(branches, (branch) => runBody(level, branch), {
        concurrency: "unbounded",
        discard: true,
      }),
    Seq: ({ steps: inOrder }) => runBody(level, inOrder),
    Sleep: ({ ms }) => Effect.sleep(Duration.millis(ms)),
    Slow: ({ ms }) =>
      Effect.flatMap(SqlClient, (sql) =>
        Effect.orDie(sql`select pg_sleep(${ms / 1000})`)
      ).pipe(Effect.asVoid),
    Write: () => write(ledger, level),
  });
};

/** The ledger of one run: the program runs to its end, and every fiber that it left behind is awaited. */
export const run = (program: Program, prefix: string) =>
  Effect.scoped(
    Effect.gen(function* runProgram() {
      const scope = yield* Effect.scope;

      const ledger: Ledger = {
        events: [],
        fibers: [],
        levels: [],
        prefix,
        scope,
        writes: [],
      };

      yield* levelOf(
        ledger,
        bodyRunner((level, one) => runStep(ledger, level, one)),
        NO_LEVEL,
        program.ending,
        program.body,
        boundOf(program.ending)
      );

      yield* Effect.forEach(
        ledger.fibers,
        (fiber) => Effect.timeoutOption(Fiber.await(fiber), "10 seconds"),
        { concurrency: "unbounded", discard: true }
      );

      return ledger;
    })
  );

/** The labels of the rows of the run in the committed state of the outbox. */
export const committedLabels = (prefix: string) =>
  Effect.gen(function* committed() {
    const sql = yield* SqlClient;

    const rows = yield* sql<{
      readonly label: string;
    }>`select payload ->> 'text' as label from outbox where payload ->> 'text' like ${`${prefix}%`}`;

    return new Set(Arr.map(rows, (row) => row.label));
  });

// ---- the oracle ------------------------------------------------------------------------------------------------

/**
 * What became of the rows written in a level, from what its levels reported. A level whose exit failed by interruption
 * alone, after the event that `withTransaction` records on its span before it sends the `RELEASE` or `COMMIT`, has merged:
 * the statement runs where it cannot be interrupted, and a statement that fails adds a defect or a failure to the cause,
 * so an interrupts-only exit means it succeeded. The interruption is reported afterwards (R26). A level that failed, was
 * interrupted before that event, or was interrupted without reaching its commit, rolled back, and its rows with it.
 */
type Fate = "committed" | "rolledBack";

const fateOf = (record: LevelRecord): Fate =>
  record.committed || record.mergedAfterInterrupt ? "committed" : "rolledBack";

/** The fate of the rows of a level and of every level around it: a rollback anywhere decides it. */
const chainFate = (ledger: Ledger, level: number): Fate => {
  if (level === NO_LEVEL) {
    return "committed";
  }

  const record = ledger.levels[level];

  return record !== undefined &&
    fateOf(record) === "committed" &&
    chainFate(ledger, record.parent) === "committed"
    ? "committed"
    : "rolledBack";
};

/**
 * What the run got wrong: empty when every write is where the levels it reported into say it is. A write that reported
 * success in a level that merged after its interruption must be present, and one in a level that rolled back must be
 * absent; a refused write is absent.
 */
export const violations = (
  ledger: Ledger,
  present: ReadonlySet<string>
): readonly string[] =>
  Arr.flatMap(ledger.writes, (record) => {
    const fate = chainFate(ledger, record.level);
    const there = present.has(record.label);

    const problem = Match.value(record.outcome).pipe(
      Match.when("ok", () =>
        there === (fate === "committed")
          ? ""
          : `${record.label} reported success in level ${record.level} (fate of its levels: ${fate}) and ${there ? "is" : "is not"} in the committed state`
      ),
      Match.when("refused", () =>
        there ? `${record.label} was refused and is in the committed state` : ""
      ),
      Match.orElse(() =>
        there && fate === "rolledBack"
          ? `${record.label} did not finish, belongs to level ${record.level} (rolled back) and is in the committed state`
          : ""
      )
    );

    return problem === "" ? [] : [problem];
  });

/** The deepest nesting of levels in the body, the root counted as 1. */
export const depthOf = (body: Body): number =>
  1 +
  Arr.reduce(body, 0, (deepest, step) =>
    Math.max(
      deepest,
      steps.$match(step, {
        Bounded: (bounded) => depthOf(bounded.body),
        Fork: (fork) => depthOf(fork.body) - 1,
        Level: (level) => depthOf(level.body),
        Par: (par) =>
          Arr.reduce(par.branches, 0, (most, branch) =>
            Math.max(most, depthOf(branch) - 1)
          ),
        Seq: (seq) => depthOf(seq.steps) - 1,
        Sleep: () => 0,
        Slow: () => 0,
        Write: () => 0,
      })
    )
  );

/** What a run did, for the report: the levels it opened, the writes it made, how many were refused. */
export const summary = (ledger: Ledger) => ({
  interruptedAtCommit: Arr.length(
    Arr.filter(ledger.levels, (record) => record.mergedAfterInterrupt)
  ),
  levels: ledger.levels.length,
  refused: Arr.length(
    Arr.filter(ledger.writes, (record) => record.outcome === "refused")
  ),
  writes: ledger.writes.length,
});

/** The violations of a run with the order in which things happened, or nothing when there is none. */
export const reportOf = (ledger: Ledger, found: readonly string[]) =>
  found.length === 0
    ? ""
    : `${Arr.join(found, "; ")}\n${Arr.join(ledger.events, "\n")}`;

/**
 * A level that is interrupted after its closing statement was issued, made to happen: the level's two writes are
 * followed by a statement that holds the connection for 400 ms, so its `RELEASE` queues behind it, and a deadline of 150
 * ms interrupts the level while the statement waits. A second level after it fails, and its write rolls back.
 */
export const interruptedAtItsCommit: Program = {
  body: [
    steps.Bounded({
      body: [
        steps.Write(),
        steps.Write(),
        steps.Fork({
          body: [steps.Slow({ ms: 400 })],
          delay: 0,
          kind: "child",
        }),
        steps.Sleep({ ms: 30 }),
      ],
      ms: 150,
    }),
    steps.Level({ body: [steps.Write()], ending: "fail" }),
  ],
  ending: "commit",
};
