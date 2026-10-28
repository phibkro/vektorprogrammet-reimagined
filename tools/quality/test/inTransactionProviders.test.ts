/**
 * Spec 0018, falsifier 6 (guarantee TX5): `InTransaction` is provided only by a `Transactor` or by a test composition that
 * keeps TX1 to TX3. The proof is an ordinary value, so nothing in the types stops `Effect.provideService(program,
 * InTransaction, …)` anywhere; this test is what does.
 *
 * The scan is inverted (round 2, finding 1). It does not list the ways to provide the proof, which two rounds of
 * reviewers each beat with a new spelling; it flags every reference to the service as a value (`proofReferences`,
 * `support/proofReferences.ts` has the rule and what it cannot see), except `yield* InTransaction`, a type position and
 * the import and export declarations. A file with such a reference must be in one allowlist with its reason and the
 * number of its places, and an allowance that no file needs, or that is exceeded, fails, so the list only shrinks.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order, Record as Rec } from "effect";

import { proofReferences } from "./support/proofReferences.ts";
import { readSources } from "./support/sources.ts";

const root = new URL("../../../", import.meta.url).pathname;

interface Allowance {
  readonly path: string;
  /** How many places of the file the scan flags: a second provider in an allowed file fails too. */
  readonly calls: number;
  readonly reason: string;
}

const allowances: readonly Allowance[] = [
  {
    calls: 2,
    path: "packages/db/src/transactional.ts",
    reason:
      "the one production provider: `transactional`, under `Transactor.run`",
  },
  {
    calls: 1,
    path: "packages/domain/test/support/inMemory.ts",
    reason: "the in-memory test composition of the domain's tests",
  },
  {
    calls: 1,
    path: "apps/web/test/support/memory.ts",
    reason: "the in-memory `Transactor` of the web app's tests",
  },
  {
    calls: 2,
    path: "packages/db/test/aggregates.postgres.test.ts",
    reason: "the case that shows a forged proof is refused by the lock (LK3)",
  },
  {
    calls: 2,
    path: "packages/domain/src/shared/guarantees.ts",
    reason:
      "the declaration of TX3 and TX5 hands the service to `wholePort`, which reads its key and provides nothing",
  },
];

const sourcePattern = /\.(?:[cm]?[jt]sx?)$/u;

/** `storeBoundary.test.ts` writes its probe files into the tree for a moment, and this test runs beside it. */
const skipped =
  /(?:^|\/)(?:node_modules|dist|\.devenv|\.output)(?:\/|$)|storeBoundaryProbe/u;

const referencesIn = (source: string) => proofReferences("x.ts", source).length;

/** The forgeries that the reviewers of round 1 and round 2 wrote, each of which type-checks (`/tmp/r2conf/forgery{A..F}.ts`). */
const FORGERIES = {
  "A: an aliased import, provideService": `import { InTransaction as Proof } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeA = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, Proof, { kind: "database-transaction" });`,
  "B: provideServiceEffect": `import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeB = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideServiceEffect(program, InTransaction, Effect.succeed({ kind: "database-transaction" as const }));`,
  "C: InTransaction as typeof InTransaction": `import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeC = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, InTransaction as typeof InTransaction, { kind: "database-transaction" });`,
  "D: a container, then a member": `import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
const services = { proof: InTransaction };
export const forgeD = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, services.proof, { kind: "database-transaction" });`,
  "E: parentheses": `import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeE = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, (InTransaction), { kind: "database-transaction" });`,
  "F: a tuple destructuring": `import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
const [Proof] = [InTransaction] as const;
export const forgeF = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, Proof, { kind: "database-transaction" });`,
} as const;

/** Each wrapper, container and way to hold the name, as one reference to the service. */
const HOLDING = [
  "const proof = InTransaction.of({ kind: 'database-transaction' });",
  "Effect.provideService(program, InTransaction, proof);",
  "Effect.provideServiceEffect(program, InTransaction, Effect.succeed(proof));",
  "Layer.succeed(InTransaction)({ kind: 'database-transaction' });",
  "Context.make(InTransaction, { kind: 'database-transaction' });",
  "anything((InTransaction));",
  "anything(InTransaction as typeof InTransaction);",
  "anything(InTransaction as unknown as typeof InTransaction);",
  "anything(InTransaction satisfies object);",
  "anything(InTransaction!);",
  "anything(<typeof InTransaction>InTransaction);",
  "anything({ proof: InTransaction });",
  "anything({ InTransaction });",
  "anything([InTransaction]);",
  "anything([...[InTransaction]]);",
  "anything(...[InTransaction]);",
  "anything(cond ? InTransaction : other);",
  "anything(cond && InTransaction);",
  "anything(other ?? InTransaction);",
  "anything((0, InTransaction));",
  "anything(() => InTransaction);",
  "anything(await InTransaction);",
  "const [Proof] = [InTransaction] as const;",
  "const { Proof } = { Proof: InTransaction };",
  "const alias = InTransaction;",
  "export const Proof = InTransaction;",
  "export default InTransaction;",
  "anything(Domain.InTransaction);",
  "anything(Domain?.InTransaction);",
  "anything(Domain['InTransaction']);",
  "anything(Domain[`InTransaction`]);",
  "anything((Domain as typeof Domain).InTransaction);",
  "const { InTransaction: Proof } = Domain;",
  "const { InTransaction } = Domain;",
  "const { InTransaction: Proof = fallback } = Domain;",
  "const { InTransaction: Proof } = await import('@vektorprogrammet/domain');",
  "export { InTransaction as Proof } from '@vektorprogrammet/domain';",
  "import { InTransaction as Proof } from 'x'; export { Proof };",
  "import * as D from 'x'; type T = typeof D.InTransaction; import P = D.InTransaction;",
  "import { InTransaction as Proof } from 'x'; anything(Proof);",
  "import { InTransaction as Proof } from 'x'; const Other = Proof; anything(Other);",
] as const;

/** What only reads the service, or names it without holding it. */
const READING = [
  "const run = Effect.gen(function* () { yield* InTransaction; });",
  "const run = Effect.gen(function* () { yield* (InTransaction); });",
  "const run = Effect.gen(function* () { yield* InTransaction as typeof InTransaction; });",
  "const run = Effect.gen(function* () { const proof = yield* InTransaction; return proof; });",
  "const run = Effect.gen(function* () { yield* Domain.InTransaction; });",
  "type R = Exclude<R, InTransaction>;",
  "type P = Effect.Effect<void, never, InTransaction>;",
  "type Q = typeof InTransaction;",
  "type S = Domain.InTransaction;",
  "declare const x: InTransaction;",
  "function f(proof: InTransaction): InTransaction { return proof; }",
  "const g = <T extends InTransaction>(x: T) => x;",
  "anything<InTransaction>();",
  "anything(x as InTransaction);",
  "anything(x satisfies InTransaction);",
  "anything(<InTransaction>x);",
  "class C implements InTransaction {}",
  "interface I extends InTransaction {}",
  "import type { InTransaction } from 'x';",
  "import { InTransaction } from 'x';",
  "import { type InTransaction } from 'x';",
  "export { InTransaction };",
  "export type { InTransaction } from 'x';",
  "export * from 'x';",
  "const NotStore = { InTransaction: 'a reason' };",
  "class C { InTransaction = 1; InTransaction2() {} }",
  "class InTransaction extends Base {}",
  "function InTransaction() {}",
  "anything(Domain.Outbox);",
  "anything(inTransaction);",
  "import { Outbox as Proof } from 'x'; anything(Proof);",
  "const text = 'InTransaction';",
] as const;

describe("InTransaction has few providers (spec 0018)", () => {
  it("falsifier 6, control: all six forgeries of the reviewers are found", () => {
    for (const [name, source] of Rec.toEntries(FORGERIES)) {
      assert.isAbove(referencesIn(source), 0, name);
    }
  });

  it("falsifier 6, control: every wrapper, container and way to hold the name is a reference", () => {
    for (const source of HOLDING) {
      assert.isAbove(referencesIn(source), 0, source);
    }
  });

  it("falsifier 6, control: what only reads the service, or names a type or a key, is not a reference", () => {
    for (const source of READING) {
      assert.strictEqual(referencesIn(source), 0, source);
    }
  });

  it("falsifier 6, control: the number of places is the number of references", () => {
    assert.strictEqual(
      referencesIn(
        "Effect.provideService(program, InTransaction, proof);\nLayer.succeed(InTransaction)(proof);\nconst { InTransaction: Proof } = Domain; anything(Proof);"
      ),
      4
    );
  });

  it.effect(
    "falsifier 6: only the allowed files hold InTransaction as a value, with the number of places each allows",
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
            lines: proofReferences(path, text),
            path,
          })),
          ({ lines }) => lines.length > 0
        );

        const actual = Arr.map(
          providing,
          ({ lines, path }) => `${path}: ${lines.length}`
        );

        const expected = Arr.map(
          allowances,
          ({ calls, path }) => `${path}: ${calls}`
        );

        // One comparison says all three things: a file that holds the proof and is not allowed, an allowance that no
        // file needs, and a file that holds it in more places than its allowance counts.
        assert.deepStrictEqual(
          Arr.sort(actual, Order.String),
          Arr.sort(expected, Order.String),
          "the files that hold InTransaction as a value, with the number of places, are not the allowances"
        );
      }),
    // The scan lists the whole tree, node_modules included, before it filters; a two-CPU runner took more than 5 s.
    60_000
  );
});
