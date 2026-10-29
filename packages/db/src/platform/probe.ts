/**
 * The adapter of `PlatformProbe` (spec 0025): the properties that the domain asks of a platform (`PlatformRequirements`),
 * shown on the platform this adapter runs on, with the constructs the adapter really uses, plus the one check that is the
 * adapter's own (`statements-follow-the-profile`, decision D7).
 *
 * - **Locks** (`lock-excludes-second-holder`, `lock-ends-with-its-transaction`, `held-record-is-not-handed-on`): one
 *   transaction takes `SELECT … FOR NO KEY UPDATE` on the admin list's one row (the row that `AggregateLocks` takes) and
 *   holds it; a second transaction, on a second connection of the pool, asks for it with `NOWAIT` (and a third time with
 *   `SKIP LOCKED`), first while the row is held and then after the holder ended. Nothing waits: a refused lock is an
 *   answer. Under Hyperdrive the two transactions are two origin connections, which is the point.
 * - **Transactions** (`rollback-leaves-nothing`, `nested-scope-undoes-alone`): rows are written into the fake mailbox
 *   under a random key and rolled back; the probe reads what is left, on the connection that wrote and afterwards.
 * - **Statements**: after parameterised statements, the connection holds no statement that this client named (profile
 *   `hyperdrive`) or holds some (profile `direct`).
 *
 * The probe never interrupts a statement (what Hyperdrive does with a cancel is unverified, and a probe must not be the
 * first to find out), writes nothing that it does not roll back, and takes no lock that a command holds for long: a
 * production deployment does not run it. A step that cannot run is `held: false` with the reason, so the other checks are
 * still reported.
 */
import { ADMIN_LIST_ID, PlatformProbe } from "@vektorprogrammet/domain";
import type { PlatformCheckResult } from "@vektorprogrammet/domain";
import type { Duration } from "effect";
import {
  Array as Arr,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import type { Construct } from "./constructs.ts";
import type { ConnectionProfile } from "./profiles.ts";

/** SQLSTATE `lock_not_available`: what `NOWAIT` answers for a row that another transaction holds. */
const LOCK_NOT_AVAILABLE = "55P03";

/** What a check found out: whether the property held, and what was observed, in the engine's words. */
interface Verdict {
  readonly held: boolean;
  readonly detail: string;
}

/** The SQLSTATE of a failed exit that failed with a SQL error that carries one. */
const sqlStateOf = (
  exit: Exit.Exit<unknown, unknown>
): Option.Option<string> =>
  Exit.isFailure(exit)
    ? Option.flatMap(Cause.findErrorOption(exit.cause), (failure) =>
        isSqlError(failure) &&
        Predicate.hasProperty(failure.reason, "cause") &&
        Predicate.hasProperty(failure.reason.cause, "code") &&
        Predicate.isString(failure.reason.cause.code)
          ? Option.some(failure.reason.cause.code)
          : Option.none()
      )
    : Option.none();

/** What a cause says in a report that an anonymous request can read: its first line, trimmed. */
const shortCause = (cause: Cause.Cause<unknown>): string =>
  (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, 160);

/** What a failed exit says, short enough for a report. */
const failureText = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit)
    ? Option.match(sqlStateOf(exit), {
        onNone: () => `failed: ${shortCause(exit.cause)}`,
        onSome: (state) => `failed with SQLSTATE ${state}`,
      })
    : "succeeded";

/**
 * The seen count of a probe transaction that ended on purpose: it fails with the number of rows it saw, and a SQL failure
 * is never a number. `None` when it ended another way.
 */
const rolledBackWith = (
  exit: Exit.Exit<unknown, unknown>
): Option.Option<number> =>
  Exit.isFailure(exit)
    ? Option.filter(Cause.findErrorOption(exit.cause), Predicate.isNumber)
    : Option.none();

/** How many rows a successful ask got. */
const rowsOf = (exit: Exit.Exit<readonly unknown[], unknown>) =>
  Exit.isSuccess(exit) ? Option.some(exit.value.length) : Option.none();

/** The rows an ask got as text, or what it failed with. */
const rowsText = (exit: Exit.Exit<readonly unknown[], unknown>) =>
  Option.match(rowsOf(exit), {
    onNone: () => failureText(exit),
    onSome: String,
  });

export interface PlatformProbeOptions {
  /** How long one check may take before it is reported as not run. The default is 15 seconds. */
  readonly checkTimeout?: Duration.Input | undefined;
}

/** The probe of `profile`: `profile.client.prepare` says whether the client names the statements it sends. */
export const PlatformProbeLive = (
  profile: ConnectionProfile<Construct>,
  options: PlatformProbeOptions = {}
) =>
  Layer.effect(
    PlatformProbe,
    Effect.gen(function* buildProbe() {
      const sql = yield* SqlClient;
      const checkTimeout = options.checkTimeout ?? "15 seconds";

      /** A check that cannot run is a check that did not hold, with the reason: the others are still reported. */
      const settle = (
        id: string,
        run: Effect.Effect<Verdict, unknown>
      ): Effect.Effect<PlatformCheckResult> =>
        run.pipe(
          Effect.timeout(checkTimeout),
          Effect.map((verdict) => ({ id, ...verdict })),
          Effect.catchCause((cause) =>
            Effect.succeed({
              detail: `could not run: ${shortCause(cause)}`,
              held: false,
              id,
            })
          )
        );

      const randomKeys = sql<{ readonly a: string; readonly b: string }>`
        select 'platform-probe-' || gen_random_uuid()::text as a, 'platform-probe-' || gen_random_uuid()::text as b`.pipe(
        Effect.flatMap((rows) =>
          Option.match(Arr.head(rows), {
            onNone: () =>
              Effect.die("the store returned no row for a constant select"),
            onSome: Effect.succeed,
          })
        )
      );

      const insertMail = (key: string) =>
        sql`insert into captured_mail (delivery_key, recipient, sent_at, subject, text)
            values (${key}, 'probe@example.org', now(), 'platform probe', 'rolled back')`;

      const countMail = (...keys: readonly string[]) =>
        sql<{
          readonly n: number;
        }>`select count(*)::int as n from captured_mail where delivery_key in ${sql.in(keys)}`.pipe(
          Effect.map((rows) => rows[0]?.n ?? -1)
        );

      const rollbackLeavesNothing = Effect.gen(
        function* rollbackLeavesNothing() {
          const { a } = yield* randomKeys;

          const exit = yield* sql
            .withTransaction(
              Effect.gen(function* writeAndFail() {
                yield* insertMail(a);
                const seen = yield* countMail(a);

                return yield* Effect.fail(seen);
              })
            )
            .pipe(Effect.exit);

          const inside = rolledBackWith(exit);
          const after = yield* countMail(a);

          return {
            detail: Option.match(inside, {
              onNone: () =>
                `the transaction did not end as planned: ${failureText(exit)}`,
              onSome: (seen) =>
                `the writer saw ${seen} row of its own, and ${after} remained after the rollback`,
            }),
            held: Option.contains(inside, 1) && after === 0,
          };
        }
      );

      const nestedScopeUndoesAlone = Effect.gen(
        function* nestedScopeUndoesAlone() {
          const { a, b } = yield* randomKeys;

          const exit = yield* sql
            .withTransaction(
              Effect.gen(function* outer() {
                yield* insertMail(a);

                yield* sql
                  .withTransaction(
                    insertMail(b).pipe(Effect.andThen(Effect.fail(0)))
                  )
                  .pipe(Effect.exit);

                const seen = yield* countMail(a, b);

                return yield* Effect.fail(seen);
              })
            )
            .pipe(Effect.exit);

          const inside = rolledBackWith(exit);
          const after = yield* countMail(a, b);

          return {
            detail: Option.match(inside, {
              onNone: () =>
                `the transaction did not end as planned: ${failureText(exit)}`,
              onSome: (seen) =>
                `after the nested scope failed the outer scope saw ${seen} of its 2 keys (its own), and ${after} remained after it rolled back`,
            }),
            held: Option.contains(inside, 1) && after === 0,
          };
        }
      );

      const lockRow = sql`select id from admin_list where id = ${ADMIN_LIST_ID} for no key update`;

      const askNoWait = sql
        .withTransaction(
          sql<{
            readonly id: number;
          }>`select id from admin_list where id = ${ADMIN_LIST_ID} for no key update nowait`
        )
        .pipe(Effect.exit);

      const askSkipLocked = sql
        .withTransaction(
          sql<{
            readonly id: number;
          }>`select id from admin_list where id = ${ADMIN_LIST_ID} for update skip locked`
        )
        .pipe(Effect.exit);

      const LOCK_CHECK_IDS = [
        "lock-excludes-second-holder",
        "lock-ends-with-its-transaction",
        "held-record-is-not-handed-on",
      ] as const;

      const lockChecksNotRun = (
        detail: string
      ): readonly PlatformCheckResult[] =>
        Arr.map(LOCK_CHECK_IDS, (id) => ({ detail, held: false, id }));

      /** The three lock checks, from one holder: a transaction on one connection, two asks on another, before and after. */
      const lockChecks = Effect.gen(function* lockChecks() {
        const taken = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<null>();

        const holder = yield* Effect.forkChild(
          sql
            .withTransaction(
              Effect.gen(function* hold() {
                // The holder never waits for a command that holds the admin list (a few seconds, then the check says so).
                yield* sql`set local lock_timeout = '3s'`;
                yield* lockRow;
                yield* Deferred.succeed(taken, true);
                yield* Deferred.await(release);
              })
            )
            .pipe(Effect.ensuring(Deferred.succeed(taken, false)), Effect.exit)
        );

        if (!(yield* Deferred.await(taken))) {
          return lockChecksNotRun(
            `the holder could not take the row's lock: ${failureText(yield* Fiber.join(holder))}`
          );
        }

        const whileHeld = yield* Effect.gen(function* askWhileHeld() {
          return { noWait: yield* askNoWait, skip: yield* askSkipLocked };
        }).pipe(Effect.ensuring(Deferred.succeed(release, null)));

        yield* Fiber.join(holder);

        const afterwards = {
          noWait: yield* askNoWait,
          skip: yield* askSkipLocked,
        };

        const refused = Option.contains(
          sqlStateOf(whileHeld.noWait),
          LOCK_NOT_AVAILABLE
        );

        return [
          {
            detail: refused
              ? `while the first transaction held the row, the second was refused with SQLSTATE ${LOCK_NOT_AVAILABLE}`
              : `while the first transaction held the row, the second ${failureText(whileHeld.noWait)}`,
            held: refused,
            id: "lock-excludes-second-holder",
          },
          {
            detail: `after the holder's transaction ended, a second transaction got ${rowsText(afterwards.noWait)} row(s)`,
            held: Option.contains(rowsOf(afterwards.noWait), 1),
            id: "lock-ends-with-its-transaction",
          },
          {
            detail: `a claimer that skips locked rows got ${rowsText(whileHeld.skip)} row(s) while the row was held and ${rowsText(afterwards.skip)} after it ended`,
            held:
              Option.contains(rowsOf(whileHeld.skip), 0) &&
              Option.contains(rowsOf(afterwards.skip), 1),
            id: "held-record-is-not-handed-on",
          },
        ] satisfies readonly PlatformCheckResult[];
      });

      const lockChecksSettled = lockChecks.pipe(
        Effect.timeout(checkTimeout),
        Effect.catchCause((cause) =>
          Effect.succeed(
            lockChecksNotRun(`could not run: ${shortCause(cause)}`)
          )
        )
      );

      const statementsFollowTheProfile = sql
        .withTransaction(
          Effect.gen(function* sendStatements() {
            // The statement carries a token that no other client has, so the count is of this client's statements and
            // not of whatever another client left on a server connection that a pooler shares.
            const [issued] = yield* sql<{
              readonly token: string;
            }>`select replace(gen_random_uuid()::text, '-', '') as token`;

            const marker = `platform-probe-${issued?.token ?? "none"}`;
            yield* sql.unsafe(`select $1::int as n /* ${marker} */`, [1]);

            const rows = yield* sql<{
              readonly named: number;
            }>`select count(*)::int as named from pg_prepared_statements where statement like ${`%${marker}%`}`;

            return rows[0]?.named ?? -1;
          })
        )
        .pipe(
          Effect.map((named): Verdict =>
            profile.client.prepare
              ? {
                  detail: `profile ${profile.name} names its statements: the connection holds ${named} of them`,
                  held: named > 0,
                }
              : {
                  detail: `profile ${profile.name} sends unnamed statements: the connection holds ${named} named by this client`,
                  held: named === 0,
                }
          )
        );

      return PlatformProbe.of({
        report: Effect.gen(function* report() {
          const checks = [
            yield* settle("rollback-leaves-nothing", rollbackLeavesNothing),
            yield* settle("nested-scope-undoes-alone", nestedScopeUndoesAlone),
            ...(yield* lockChecksSettled),
            yield* settle(
              "statements-follow-the-profile",
              statementsFollowTheProfile
            ),
          ];

          return { checks, profile: profile.name };
        }),
      });
    })
  );
