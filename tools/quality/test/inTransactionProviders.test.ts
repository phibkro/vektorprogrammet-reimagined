/**
 * Spec 0018, falsifier 6 (guarantee TX5): `InTransaction` is provided only by a `Transactor` or by a test composition that
 * keeps TX1 to TX3. The proof is an ordinary value, so nothing in the types stops `Effect.provideService(program,
 * InTransaction, …)` anywhere; this test is what does.
 *
 * The scan follows the binding and not the callee (round 1, finding 1). In each file it collects every local name bound
 * to the service (`import { InTransaction as Proof }`, `const Proof = InTransaction`, `const { InTransaction: Proof } =
 * Domain`, a member `Domain.InTransaction`), and flags any call that is handed one of them as an argument, whatever the
 * callee is called (`provideService`, `provideServiceEffect`, `Layer.succeed(Proof)(…)`, `Context.make(Proof, …)`), and
 * any call of `.of` on one. A renaming re-export (`export { InTransaction as X }`) and an exported alias are flagged
 * too, since another file could import the new name. Each flagged file must be in one allowlist with its reason, and an
 * allowance that no file needs fails, so the list only shrinks.
 *
 * What it does not follow: a binding that leaves the file under another name through a computed access
 * (`Domain["In" + "Transaction"]`), and a value passed through a function that returns it. A reviewer reads those.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order } from "effect";
import { Visitor, parseSync } from "oxc-parser";
import type { Program } from "oxc-parser";

import { readSources } from "./support/sources.ts";

const root = new URL("../../../", import.meta.url).pathname;

const SERVICE = "InTransaction";

interface Located {
  readonly start: number;
  readonly end: number;
}

/** A module export name as written, without the quotes of a string name. */
const bare = (written: string): string => written.replaceAll(/["']/gu, "");

/** The local names that a file binds to the service: its import, an alias of it, a destructured member. */
const boundNames = (text: string, program: Program): ReadonlySet<string> => {
  const written = (node: Located) => text.slice(node.start, node.end);
  const names = new Set<string>([SERVICE]);
  const aliases: { readonly name: string; readonly init: string }[] = [];

  const isBound = (expression: string) =>
    names.has(expression) || expression.endsWith(`.${SERVICE}`);

  new Visitor({
    ImportSpecifier(node) {
      if (bare(written(node.imported)) === SERVICE) {
        names.add(node.local.name);
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init !== null) {
        aliases.push({ init: written(node.init), name: node.id.name });
      }

      if (node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            bare(written(property.key)) === SERVICE &&
            property.value.type === "Identifier"
          ) {
            names.add(property.value.name);
          }
        }
      }
    },
  }).visit(program);

  // An alias of an alias, in any order of declaration.
  let grew = true;

  while (grew) {
    grew = false;

    for (const alias of aliases) {
      if (!names.has(alias.name) && isBound(alias.init)) {
        names.add(alias.name);
        grew = true;
      }
    }
  }

  return names;
};

/**
 * The lines of `text` that provide the service, or let its name escape under another one: a call that is handed a
 * binding of it, a call of `.of` on one, a renaming re-export, an exported alias. A file that never writes the name
 * cannot do any of that (an aliased import still writes it), so it is not parsed: the scan reads every file of three
 * directories, and a two-CPU runner parsed them all in more than the test's five seconds.
 */
export const providers = (path: string, text: string): readonly number[] => {
  if (!text.includes(SERVICE)) {
    return [];
  }

  const { program } = parseSync(path, text);
  const names = boundNames(text, program);
  const found: number[] = [];
  const written = (node: Located) => text.slice(node.start, node.end);

  const isBound = (expression: string) =>
    names.has(expression) || expression.endsWith(`.${SERVICE}`);

  const flag = (node: Located) => {
    found.push(text.slice(0, node.start).split("\n").length);
  };

  new Visitor({
    CallExpression(node) {
      const handedOn = Arr.some(node.arguments, (argument) =>
        isBound(written(argument))
      );

      const madeBy =
        node.callee.type === "MemberExpression" &&
        isBound(written(node.callee.object)) &&
        written(node.callee.property) === "of";

      if (handedOn || madeBy) {
        flag(node);
      }
    },
    ExportNamedDeclaration(node) {
      const aliased =
        node.declaration?.type === "VariableDeclaration" &&
        Arr.some(
          node.declaration.declarations,
          (declarator) =>
            declarator.init !== null && isBound(written(declarator.init))
        );

      const renamed = Arr.some(
        node.specifiers,
        (specifier) =>
          bare(written(specifier.local)) === SERVICE &&
          bare(written(specifier.exported)) !== SERVICE
      );

      if (aliased || renamed) {
        flag(node);
      }
    },
  }).visit(program);

  return found;
};

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
      "the declaration of TX1 and TX5 hands the service to `wholePort`, which reads its key and provides nothing",
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
      "Effect.provideServiceEffect(program, InTransaction, Effect.succeed(proof))",
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

  it("falsifier 6, control: the two forgeries of round 1 and the other ways to hold the name are found", () => {
    for (const source of [
      // Round 1, finding 1: an aliased import, and `provideServiceEffect`.
      "import { InTransaction as Proof } from '@vektorprogrammet/domain';\nconst forged = Effect.provideService(program, Proof, { kind: 'database-transaction' });",
      "import { InTransaction } from '@vektorprogrammet/domain';\nconst forged = Effect.provideServiceEffect(program, InTransaction, Effect.succeed(proof));",
      // Whatever the callee is called.
      "import { InTransaction as Proof } from 'x';\nconst forged = Layer.succeed(Proof)({ kind: 'database-transaction' });",
      "import { InTransaction as Proof } from 'x';\nconst forged = Context.make(Proof, { kind: 'database-transaction' });",
      "import { InTransaction as Proof } from 'x';\nconst forged = Proof.of({ kind: 'database-transaction' });",
      // An alias of an alias, in either order; a namespace member; a destructured member.
      "import { InTransaction } from 'x';\nconst B = A;\nconst A = InTransaction;\nconst forged = anything(B, proof);",
      "import * as Domain from 'x';\nconst forged = anything(Domain.InTransaction, proof);",
      "const { InTransaction: Proof } = Domain;\nconst forged = anything(Proof, proof);",
      // The name leaves the file as another one.
      "export { InTransaction as Proof } from 'x';",
      "import { InTransaction } from 'x';\nexport const Proof = InTransaction;",
    ]) {
      assert.lengthOf(providers("x.ts", source), 1, source);
    }

    for (const source of [
      "import { InTransaction as Proof } from 'x';\ntype R = Exclude<R, Proof>;\nconst run = Effect.gen(function* () { yield* Proof; });",
      "import { InTransaction } from 'x';\nexport { InTransaction };",
      "import { Outbox as Proof } from 'x';\nconst fine = Effect.provideService(program, Proof, outbox);",
    ]) {
      assert.lengthOf(providers("x.ts", source), 0, source);
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

        const actual = Arr.map(
          providing,
          ({ lines, path }) => `${path}: ${lines.length}`
        );

        const expected = Arr.map(
          allowances,
          ({ calls, path }) => `${path}: ${calls}`
        );

        // One comparison says all three things: a file that provides and is not allowed, an allowance that no file needs,
        // and a file that provides in more places than its allowance counts.
        assert.deepStrictEqual(
          Arr.sort(actual, Order.String),
          Arr.sort(expected, Order.String),
          "the files that provide InTransaction, with the number of places, are not the allowances"
        );
      }),
    // The scan lists the whole tree, node_modules included, before it filters; a two-CPU runner took more than 5 s.
    60_000
  );
});
