/**
 * Spec 0019 R21: the stack is PostgreSQL's savepoint stack, and one generated property over random programs closes the
 * class that the review rounds found one probe at a time.
 *
 * A program (`support/savepointPrograms.ts`) opens nested levels to depth 4 or more, forks fibers inside them by
 * `forkChild`, `forkIn` and `forkDetach`, ends levels by commit, typed failure, defect, interruption or timeout, runs
 * methods of a level at once, and writes before and after levels end. Each runs on one PostgreSQL connection. The
 * invariant, with no model of PostgreSQL: a write that reported success is in the final committed state if and only if its
 * level and every level around it reported success; a write that was refused is not there; a write that did not finish is
 * there only if its levels reported success.
 *
 * `bun run test:all` runs a bounded number of programs (`LIVE_PROPERTY_RUNS`, default 3000, seed fixed so the programs are
 * the same each time); `LIVE_PROPERTY_RUNS=50000` runs more.
 */
import { assert, layer } from "@effect/vitest";
import { Arbitrary, Array as Arr, Config, Effect, String as Str } from "effect";

import { postgresDatabase } from "./support/database.ts";
import {
  committedLabels,
  depthOf,
  interruptedAtItsCommit as interruptedAtItsCommitProgram,
  programs,
  reportOf,
  run,
  summary,
  violations,
} from "./support/savepointPrograms.ts";
import type { Program } from "./support/savepointPrograms.ts";

const RUNS = Config.Int("LIVE_PROPERTY_RUNS").pipe(Config.withDefault(3000));

const SEED = Config.Int("LIVE_PROPERTY_SEED").pipe(
  Config.withDefault(20_261_029)
);

layer(postgresDatabase({ maxConnections: 4 }), {
  excludeTestServices: true,
})("spec 0019 R21: the stack is PostgreSQL's savepoint stack", (it) => {
  it.effect(
    "property: no write that reported success loses its row, and none that was refused or whose level failed commits, in any generated program",
    () =>
      Effect.gen(function* property() {
        const runs = yield* RUNS;
        const seed = yield* SEED;

        const totals = {
          cases: 0,
          deep: 0,
          interrupted: 0,
          levels: 0,
          refused: 0,
          writes: 0,
        };

        let counter = 0;
        let firstReport = "";

        const holds = (program: Program) =>
          Effect.gen(function* holdsFor() {
            counter += 1;
            const prefix = `p${counter}-`;

            // A program that hangs fails the property instead of the whole test timing out.
            const ledger = yield* Effect.timeout(
              run(program, prefix),
              "30 seconds"
            );

            const found = violations(ledger, yield* committedLabels(prefix));

            const { interruptedAtCommit, levels, refused, writes } =
              summary(ledger);

            totals.cases += 1;
            totals.interrupted += interruptedAtCommit;
            totals.levels += levels;
            totals.refused += refused;
            totals.writes += writes;
            totals.deep += Number(depthOf(program.body) >= 4);
            firstReport ||= reportOf(ledger, found);

            return yield* found.length === 0
              ? Effect.succeed(true)
              : Effect.fail(Arr.join(found, "; "));
          });

        const result = yield* Arbitrary.checkEffect(programs, holds, {
          maxShrinks: 400,
          runs,
          seed,
        });

        yield* Effect.log(
          `live proof property: ${totals.cases} programs, ${totals.levels} levels, ${totals.writes} writes (${totals.refused} refused), ${totals.deep} programs nested 4 deep or more, ${totals.interrupted} levels interrupted at their commit; result ${result._tag}, ${"runs" in result ? result.runs : 0} runs`
        );

        if (firstReport !== "") {
          yield* Effect.logError(
            `the first violation, in order:\n${firstReport}`
          );
        }

        assert.strictEqual(
          result._tag,
          "Passed",
          Arbitrary.formatCheckFailure(result) ?? result._tag
        );
      }),
    { timeout: 7_200_000 }
  );

  /**
   * Spec 0019 R26: a level interrupted after its closing statement was issued has merged (R26), and it never brings back
   * what a rolled-back level wrote. The program makes it happen: the level's
   * `RELEASE` queues behind a statement that holds the connection for 400 ms, and a deadline of 150 ms interrupts the
   * level while it waits. The controls change the committed state, or the evidence, and each must be caught.
   */
  it.effect(
    "a level interrupted after its commit statement was issued: its writes merge whole, nothing that a rolled-back level wrote comes back, and each control is caught",
    () =>
      Effect.gen(function* interruptedAtItsCommit() {
        const prefix = "u1-";
        const ledger = yield* run(interruptedAtItsCommitProgram, prefix);
        const present = yield* committedLabels(prefix);
        const order = Arr.join(ledger.events, "\n");
        const [first, second, rolledBack] = ledger.writes;
        const [, level] = ledger.levels;

        assert.isTrue(level?.mergedAfterInterrupt === true, order);
        assert.deepStrictEqual(violations(ledger, present), [], order);

        // Both writes of the interrupted level merged: the closing statement was issued, and it ran.
        assert.isTrue(present.has(first?.label ?? ""), order);
        assert.isTrue(present.has(second?.label ?? ""), order);
        assert.isFalse(present.has(rolledBack?.label ?? "?"), order);

        // Control: a store that lost a row of the interrupted level, even if it were its only one. The level has merged, so
        // a write that reported success in it and is not in the committed state is reported.
        const half = new Set(present);
        half.delete(second?.label ?? "");

        assert.isTrue(
          Arr.some(violations(ledger, half), (found) =>
            Str.includes(`${second?.label ?? "?"} reported success`)(found)
          ),
          "a row of an interrupted level that went missing was not caught"
        );

        // Control: a store that brought back what a rolled-back level wrote.
        const resurrected = new Set(present);
        resurrected.add(rolledBack?.label ?? "");

        assert.isTrue(
          Arr.some(violations(ledger, resurrected), (found) =>
            Str.includes(rolledBack?.label ?? "?")(found)
          ),
          "a write of a rolled-back level that came back was not caught"
        );

        // Control: without the evidence that the closing statement was issued the normal verdict applies, and the
        // level that was interrupted is a level that rolled back, whose rows are in the committed state.
        if (level !== undefined) {
          level.mergedAfterInterrupt = false;
        }

        assert.isAbove(violations(ledger, present).length, 0, order);
      }),
    { timeout: 60_000 }
  );
});
