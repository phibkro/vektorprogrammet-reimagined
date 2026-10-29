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
import { Arbitrary, Array as Arr, Config, Effect } from "effect";

import { postgresDatabase } from "./support/database.ts";
import {
  committedLabels,
  depthOf,
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
});
