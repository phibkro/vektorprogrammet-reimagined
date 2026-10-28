/**
 * Spec 0018, falsifier 6 (guarantee TX5): `InTransaction` is provided only by a `Transactor` or by a test composition that
 * keeps TX1 to TX3. The proof is an ordinary value, so nothing in the types stops `Effect.provideService(program,
 * InTransaction, …)` anywhere; this test is what does. It lists every place of the repository that provides the service
 * (`provideService`, `Layer.succeed`, `InTransaction.of` and the like, by the syntax tree and not by a name), and each
 * must be in one allowlist with its reason. An allowance that no file needs fails, so the list only shrinks.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";
import { Visitor, parseSync } from "oxc-parser";

import { readSources } from "./support/sources.ts";

const root = new URL("../../../", import.meta.url).pathname;

/** The last name of a callee as written: `Effect.provideService` and `provideService` are both `provideService`. */
const lastName = /(?:^|\.)(?<name>\w+)$/u;

const PROVIDERS = new Set([
  "add",
  "effect",
  "make",
  "provide",
  "provideService",
  "provideServices",
  "succeed",
  "sync",
]);

/** The lines of the calls in `text` that hand `InTransaction` to a function that provides a service, or make its value. */
export const providers = (path: string, text: string): readonly number[] => {
  const found: number[] = [];

  const written = (node: { readonly start: number; readonly end: number }) =>
    text.slice(node.start, node.end);

  new Visitor({
    CallExpression(node) {
      const callee = written(node.callee);

      const providing =
        PROVIDERS.has(lastName.exec(callee)?.groups?.name ?? "") &&
        Arr.some(
          node.arguments,
          (argument) => written(argument) === "InTransaction"
        );

      if (providing || callee === "InTransaction.of") {
        found.push(text.slice(0, node.start).split("\n").length);
      }
    },
  }).visit(parseSync(path, text).program);

  return found;
};

interface Allowance {
  readonly path: string;
  readonly reason: string;
}

const allowances: readonly Allowance[] = [
  {
    path: "packages/db/src/transactional.ts",
    reason:
      "the one production provider: `transactional`, under `Transactor.run`",
  },
  {
    path: "packages/domain/test/support/inMemory.ts",
    reason: "the in-memory test composition of the domain's tests",
  },
  {
    path: "apps/web/test/support/memory.ts",
    reason: "the in-memory `Transactor` of the web app's tests",
  },
  {
    path: "packages/db/test/aggregates.postgres.test.ts",
    reason: "the case that shows a forged proof is refused by the lock (LK3)",
  },
];

const sourcePattern = /\.(?:ts|tsx)$/u;

/** `storeBoundary.test.ts` writes its probe files into the tree for a moment, and this test runs beside it. */
const skipped =
  /(?:^|\/)(?:node_modules|dist|\.devenv|\.output)(?:\/|$)|storeBoundaryProbe/u;

describe("InTransaction has few providers (spec 0018)", () => {
  it("falsifier 6, control: the forms that provide the service are found, and a requirement is not", () => {
    for (const line of [
      "program.pipe(Effect.provideService(InTransaction, { kind: 'database-transaction' }))",
      "Effect.provideService(program, InTransaction, proof)",
      "Layer.succeed(InTransaction)({ kind: 'database-transaction' })",
      "const proof = InTransaction.of({ kind: 'database-transaction' })",
    ]) {
      assert.lengthOf(providers("x.ts", line), 1, line);
    }

    for (const line of [
      "const run = Effect.gen(function* () { yield* InTransaction; })",
      "type R = Exclude<R, InTransaction>",
      "Effect.provideService(program, Outbox, outbox)",
    ]) {
      assert.lengthOf(providers("x.ts", line), 0, line);
    }
  });

  it.effect(
    "falsifier 6: only the allowed files provide InTransaction, and every allowance is needed",
    () =>
      Effect.gen(function* fewProviders() {
        const sources = Arr.flatten(
          yield* Effect.forEach(["apps", "packages", "tools"], (directory) =>
            Effect.map(
              readSources(
                `${root}${directory}`,
                (path) => sourcePattern.test(path) && !skipped.test(path)
              ),
              Arr.map(({ path, text }) => ({
                path: `${directory}/${path}`,
                text,
              }))
            )
          )
        );

        const providing = Arr.filter(
          Arr.map(sources, ({ path, text }) => ({
            lines: providers(path, text),
            path,
          })),
          ({ lines }) => lines.length > 0
        );

        const allowed = Arr.map(allowances, ({ path }) => path);

        assert.deepStrictEqual(
          Arr.filter(
            Arr.map(providing, ({ path }) => path),
            (path) => !allowed.includes(path)
          ),
          [],
          "a file provides InTransaction and is not allowed to"
        );

        assert.deepStrictEqual(
          Arr.filter(
            allowed,
            (path) => !Arr.some(providing, (hit) => hit.path === path)
          ),
          [],
          "an allowance that no file needs"
        );
      })
  );
});
