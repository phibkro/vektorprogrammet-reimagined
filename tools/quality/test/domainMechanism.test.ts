/**
 * Spec 0018, falsifier 7: the domain states properties, not mechanisms. No file of `packages/domain/src` names an engine
 * feature (a statement, a clause, a column type, a constraint kind) outside the few lines that describe the personal
 * data catalog, which is data written in the engine's terms until stage 5 (ownership) moves it. The retention arithmetic
 * left the list with spec 0021 (ADR 0014, answer 3). An allowance that no line needs fails, so the list only shrinks.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, String as Str } from "effect";

import { domainSources } from "./support/sources.ts";

/** Upper-case keywords and engine names, whole words; `jsonb`, `savepoint` and "exclusion constraint" as written. */
const mechanism =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|ON CONFLICT|FOR NO KEY|SKIP LOCKED|RETURNING|SQLSTATE|PostgreSQL|Postgres|Drizzle|SQL)\b|\bjsonb\b|\bsavepoint\b|exclusion constraint/u;

interface Hit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export const mechanismHits = (path: string, text: string): readonly Hit[] =>
  Arr.flatMap(Str.split(text, "\n"), (line, index) =>
    mechanism.test(line) ? [{ line: index + 1, path, text: line }] : []
  );

interface Allowance {
  readonly path: string;
  /** A piece of the line, so that the allowance survives an edit above it. */
  readonly includes: string;
  readonly reason: string;
}

const CATALOG =
  "the catalog is data in the engine's terms until stage 5 (ADR 0014) declares ownership";

const allowances: readonly Allowance[] = [
  {
    includes: "by their SQL names",
    path: "personalData/catalog.ts",
    reason: CATALOG,
  },
  {
    includes: "a jsonb column",
    path: "personalData/declaration.ts",
    reason: CATALOG,
  },
];

const allowed = (hit: Hit): boolean =>
  Arr.some(
    allowances,
    (allowance) =>
      hit.path === allowance.path && Str.includes(allowance.includes)(hit.text)
  );

describe("the domain states properties, not mechanisms (spec 0018)", () => {
  it("falsifier 7, control: the words that the scan looks for are found, and ordinary words are not", () => {
    for (const line of [
      "* `INSERT … ON CONFLICT DO NOTHING`",
      "* `SELECT … FOR NO KEY UPDATE` on the row",
      "* the database's exclusion constraint refuses it",
      "* Persisted as jsonb",
      "* a savepoint that was rolled back",
      "* mirrors PostgreSQL identity columns",
      "* `DELETE … WHERE id = $1`",
    ]) {
      assert.lengthOf(mechanismHits("x.ts", line), 1, line);
    }

    for (const line of [
      "* a conditional update that matches no record",
      "* the SqlClient of the adapter",
      "* inserts the record, then deletes the old one",
    ]) {
      assert.lengthOf(mechanismHits("x.ts", line), 0, line);
    }
  });

  it.effect(
    "falsifier 7: no file of the domain names an engine feature outside the catalog's allowances",
    () =>
      Effect.gen(function* noMechanismInTheDomain() {
        const hits = Arr.flatMap(yield* domainSources, ({ path, text }) =>
          mechanismHits(path, text)
        );

        assert.deepStrictEqual(
          Arr.map(
            Arr.filter(hits, (hit) => !allowed(hit)),
            (hit) => `${hit.path}:${hit.line}: ${Str.trim(hit.text)}`
          ),
          []
        );

        // The list only shrinks: an allowance that no line needs is removed.
        assert.deepStrictEqual(
          Arr.map(
            Arr.filter(
              allowances,
              (allowance) =>
                !Arr.some(
                  hits,
                  (hit) =>
                    hit.path === allowance.path &&
                    Str.includes(allowance.includes)(hit.text)
                )
            ),
            (allowance) => `${allowance.path}: ${allowance.includes}`
          ),
          []
        );
      })
  );
});
