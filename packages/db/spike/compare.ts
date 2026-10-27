/** Equality, statements, counts, timings and (on PostgreSQL) plans for the two reads. */
import { PersonId, TeamId } from "@vektorprogrammet/domain";
import type { Semester } from "@vektorprogrammet/domain";
import { Array as Arr, Console, Duration, Effect, Order } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { isDeepStrictEqual } from "node:util";

import { capture } from "./harness.ts";
import {
  activeCurrent,
  activeRqb,
  peopleCurrent,
  peoplePageRqb,
  peopleRqb,
  teamPageCurrent,
  teamPageRqb,
} from "./reads.ts";

const CURRENT: Semester = { term: "HOST", year: 2026 };

const statementsOf = (label: string, recorded: readonly { sql: string; params: unknown[] }[]) =>
  Console.log(
    `--- ${label}: ${recorded.length} statement(s)\n${Arr.map(
      recorded,
      (r, i) => `[${i + 1}] ${r.sql}\n    params=${JSON.stringify(r.params)}`
    ).join("\n")}`
  );

const stats = (samples: readonly number[]) => {
  const sorted = Arr.sort(samples, Order.Number);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  return `mean ${mean.toFixed(2)} ms, p50 ${at(0.5).toFixed(2)} ms, p95 ${at(0.95).toFixed(2)} ms (n=${samples.length})`;
};

const time = <A, E, R>(effect: Effect.Effect<A, E, R>, runs: number) =>
  Effect.gen(function* time() {
    yield* Effect.forEach(Arr.range(1, 20), () => effect, { discard: true });
    const timed = yield* Effect.forEach(
      Arr.range(1, runs),
      () => Effect.timed(effect),
      { concurrency: 1 }
    );

    return stats(Arr.map(timed, ([d]) => Duration.toMillis(d)));
  });

export const equality = Effect.gen(function* equality() {
  let teamsEqual = 0;
  let memberTotal = 0;
  for (const n of Arr.range(1, 23)) {
    const id = TeamId.make(n);
    const a = yield* teamPageCurrent(id);
    const b = yield* teamPageRqb(id);
    memberTotal += a.members.length;
    if (isDeepStrictEqual(a, b)) {
      teamsEqual += 1;
    } else {
      yield* Console.log(`TEAM ${n} DIFFERS\n${JSON.stringify(a.members[0])}\n${JSON.stringify(b.members[0])}`);
    }
  }
  yield* Console.log(`team page equal for ${teamsEqual}/23 teams (${memberTotal} memberships compared)`);

  const p = yield* peopleCurrent(CURRENT);
  const q = yield* peopleRqb(CURRENT);
  const active = Arr.reduce(p, 0, (n, x) => n + x.memberships.length);
  yield* Console.log(
    `people list equal: ${isDeepStrictEqual(p, q)} (${p.length} people, ${active} active memberships; RQB ${q.length} people)`
  );
  const r = yield* activeCurrent(CURRENT);
  const s = yield* activeRqb(CURRENT);
  yield* Console.log(
    `active memberships (membership side) equal: ${isDeepStrictEqual(r, s)} (${r.length} vs ${s.length} rows)`
  );
});

export const report = (explain: boolean) =>
  Effect.gen(function* report() {
    const sql = yield* SqlClient;

    yield* equality;

    // The team with the most memberships.
    const busiestRows = yield* sql.unsafe<{ id: number }>(
      "select team_id as id from membership group by team_id order by count(*) desc, team_id limit 1"
    );
    const busiest = busiestRows[0]?.id ?? 1;
    const teamId = TeamId.make(busiest);

    const a = yield* capture(teamPageCurrent(teamId));
    const b = yield* capture(teamPageRqb(teamId));
    yield* statementsOf(`team page ${busiest}, current (${a.value.members.length} members)`, a.statements);
    yield* statementsOf("team page, RQB", b.statements);

    const c = yield* capture(peopleCurrent(CURRENT));
    const d = yield* capture(peopleRqb(CURRENT));
    yield* statementsOf("people + current memberships, current", c.statements);
    yield* statementsOf("people + current memberships, RQB", d.statements);
    const e = yield* capture(activeCurrent(CURRENT));
    const f = yield* capture(activeRqb(CURRENT));
    yield* statementsOf("active memberships, current (activeIn)", e.statements);
    yield* statementsOf("active memberships, RQB from membership", f.statements);

    yield* Console.log(`TIMING team page   current: ${yield* time(teamPageCurrent(teamId), 300)}`);
    yield* Console.log(`TIMING team page   RQB    : ${yield* time(teamPageRqb(teamId), 300)}`);
    yield* Console.log(`TIMING people list current: ${yield* time(peopleCurrent(CURRENT), 100)}`);
    yield* Console.log(`TIMING people list RQB    : ${yield* time(peopleRqb(CURRENT), 100)}`);
    yield* Console.log(`TIMING active       current: ${yield* time(activeCurrent(CURRENT), 200)}`);
    yield* Console.log(`TIMING active       RQB    : ${yield* time(activeRqb(CURRENT), 200)}`);

    if (explain) {
      for (const [label, recorded] of [
        ["team page, current", a.statements],
        ["team page, RQB", b.statements],
        ["people, current", c.statements],
        ["people, RQB", d.statements],
        ["active, current", e.statements],
        ["active, RQB", f.statements],
      ] as const) {
        for (const [i, statement] of recorded.entries()) {
          const plan = yield* sql.unsafe<Record<string, string>>(
            `explain (analyze, buffers) ${statement.sql}`,
            statement.params
          );
          yield* Console.log(
            `--- EXPLAIN ${label} [${i + 1}]\n${Arr.map(plan, (r) => r["QUERY PLAN"]).join("\n")}`
          );
          const [size] = yield* sql.unsafe<{ bytes: number; rows: number }>(
            `select count(*)::int as rows, coalesce(sum(octet_length(q::text)), 0)::int as bytes from (${statement.sql}) q`,
            statement.params
          );
          yield* Console.log(
            `--- PAYLOAD ${label} [${i + 1}]: ${size?.rows} row(s), ${size?.bytes} bytes as text`
          );
        }
      }
    }
  });

void PersonId;

/** `strategy: 'optimized'` (the rc.5 default) against `'basic'` on three RQB reads. */
export const strategies = (explain: boolean) =>
  Effect.gen(function* strategies() {
    const sql = yield* SqlClient;
    const cases = [
      ["team page", (s?: "basic" | "optimized") => teamPageRqb(TeamId.make(1), s)],
      ["people list", (s?: "basic" | "optimized") => peopleRqb(CURRENT, s)],
      ["people page (dept filter, limit 50 offset 100)", (s?: "basic" | "optimized") => peoplePageRqb(CURRENT, 3, s)],
    ] as const;

    for (const [label, read] of cases) {
      const base = yield* capture(read(undefined));
      const basic = yield* capture(read("basic"));
      const optimized = yield* capture(read("optimized"));
      yield* Console.log(
        `=== ${label}\n  same SQL default vs 'optimized': ${base.statements[0]?.sql === optimized.statements[0]?.sql}\n  same SQL default vs 'basic'    : ${base.statements[0]?.sql === basic.statements[0]?.sql}\n  same result basic vs optimized: ${isDeepStrictEqual(basic.value, optimized.value)}`
      );
      yield* Console.log(`  default SQL: ${base.statements[0]?.sql}\n  basic   SQL: ${basic.statements[0]?.sql}`);
      yield* Console.log(`  TIMING default: ${yield* time(read(undefined), 100)}`);
      yield* Console.log(`  TIMING basic  : ${yield* time(read("basic"), 100)}`);
      if (explain) {
        for (const [name, run] of [["default", base], ["basic", basic]] as const) {
          const statement = run.statements[0];
          if (statement !== undefined) {
            const plan = yield* sql.unsafe<Record<string, string>>(`explain (analyze, buffers) ${statement.sql}`, statement.params);
            const lines = Arr.map(plan, (r) => r["QUERY PLAN"] ?? "");
            yield* Console.log(`  --- EXPLAIN ${name}\n${Arr.join(lines, "\n")}`);
          }
        }
      }
    }
  });
