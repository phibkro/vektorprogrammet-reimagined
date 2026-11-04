/**
 * A lint against accidental provision of `InTransaction` (spec 0018, falsifier 6; reframed by spec 0019). It is not what
 * makes the proof unforgeable: the adapter does. Every adapter method that requires `InTransaction` checks at run time,
 * before its first statement, that the proof the program holds is the live transaction's own (`packages/db/src/live.ts`,
 * guarantee TX5), and a forged or leaked proof dies as `TransactionNotLive`. `packages/db/test/liveProof.postgres.test.ts`
 * shows it, with the forgeries that three rounds of review beat this scan with.
 *
 * What this test is for is the cheap, early signal: a file that holds `InTransaction` as a value, or writes its key as a
 * string, is one more place that could make a proof by accident, and the scan fails at review time what the adapter would
 * refuse only at first use. Effect keys a service by a string, and a `Context` is a map from strings to values, so a
 * program can make a value of the service without naming it; no scan of the source closes that, and none is meant to.
 * The scan therefore does not list the ways to provide the proof. It flags every reference to the service as a value, and
 * the service's key as a whole string (`support/proofReferences.ts` has the rule and the list of what it does not see),
 * except `yield* InTransaction`, a type position and the import and export declarations. A file with such a reference
 * must be in one allowlist with its reason and the number of its places, and an allowance that no file needs, or that
 * is exceeded, fails, so the list only shrinks.
 *
 * The files are the working tree's as git lists them (tracked, and untracked that no `.gitignore` excludes), so a build
 * output such as `.alchemy/` or `dist/` is not read.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InTransaction } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Order,
  Path,
  Record as Rec,
} from "effect";
import { ChildProcessSpawner } from "effect/process";

import { gitIn } from "../workingTree.ts";
import { proofReferences } from "./support/proofReferences.ts";
import { workingTreeSources } from "./support/sources.ts";

const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/u, "");

/** The key that Effect gives the service: the one reference to the service that the fixtures below need. */
const KEY = InTransaction.key;

interface Allowance {
  readonly path: string;
  /** How many places of the file the scan flags: a second provider in an allowed file fails too. */
  readonly calls: number;
  readonly reason: string;
}

const allowances: readonly Allowance[] = [
  {
    calls: 4,
    path: "packages/db/src/live.ts",
    reason:
      "the one production provider (`liveLevel`, which `transactional` runs each level in: the proof of each level, made once, provided in one place and read from the context to admit a nested level from its own level) and the check of the proof that every `Requires` method of an adapter makes (`verify`); it holds the proofs in a private stack of levels",
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
    reason:
      "the case that shows a forged proof is refused where a lock is asked for (spec 0019 and LK3)",
  },
  {
    calls: 12,
    path: "packages/db/test/liveProof.postgres.test.ts",
    reason:
      "the forgeries and the leaked proofs that the adapters' check refuses (spec 0019), and the sweep that calls every `Requires` method under a forged proof",
  },
  {
    calls: 2,
    path: "packages/domain/src/shared/guarantees.ts",
    reason:
      "the declaration of TX3 and TX5 hands the service to `wholePort`, which reads its key and provides nothing",
  },
  {
    calls: 1,
    path: "packages/domain/src/shared/transaction.ts",
    reason:
      "the declaration of the service: its key, written once, as every service declares its own",
  },
  {
    calls: 1,
    path: "packages/domain/src/shared/integrationGuard.ts",
    reason:
      "the runtime guard of the integration ports reads the proof with `Effect.serviceOption` to refuse a call made while it is held (spec 0024 R6); it provides nothing",
  },
  {
    calls: 1,
    path: "tools/quality/test/support/proofReferences.ts",
    reason:
      "the scan reads the service's key from the service, to find that string written elsewhere; it provides nothing",
  },
  {
    calls: 1,
    path: "tools/quality/test/inTransactionProviders.test.ts",
    reason:
      "the fixtures of this test read the key from the service once (`KEY`) to write the forgeries that hold it as a string; they provide nothing",
  },
];

/** The source files that the scan reads. The listing comes from git, which leaves out what `.gitignore` leaves out. */
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/u;

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

/**
 * The forgeries of round 3 that hold the key as one whole string, which Effect keys a service by (`Context.makeUnsafe`,
 * `Context.addUnsafe`, a cast object), and the three that write the name with a Unicode escape. Each type-checks.
 */
const ROUND_THREE = {
  "G: an escaped import alias": `import { \\u0049nTransaction as Proof } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeG = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, Proof, { kind: "database-transaction" });`,
  "H: an escaped identifier": `import { \\u{49}nTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeH = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, \\u{49}nTransaction, { kind: "database-transaction" });`,
  "I: an escaped member string": `import * as D from "@vektorprogrammet/domain";
import { Effect } from "effect";
export const forgeI = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, D["\\u0049nTransaction"], { kind: "database-transaction" });`,
  "O: Context.makeUnsafe with the key": `import type { InTransaction } from "@vektorprogrammet/domain";
import { Context, Effect } from "effect";
const forged = Context.makeUnsafe<InTransaction>(new Map([["${KEY}", { kind: "database-transaction" }]]));
export const forgeO = <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.provideContext(program, forged);`,
  "P: a cast object that has the key": `import type { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
const key = { key: "${KEY}" } as unknown as typeof InTransaction;
export const forgeP = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.provideService(program, key, { kind: "database-transaction" });`,
  "S: Context.addUnsafe and Layer.succeedContext with the key": `import type { InTransaction } from "@vektorprogrammet/domain";
import { Context, Effect, Layer } from "effect";
export const ForgedLayer = Layer.succeedContext(
  Context.addUnsafe<never, InTransaction, { readonly kind: "database-transaction" }>(Context.empty(), "${KEY}", { kind: "database-transaction" })
);`,
  "the key as a template without substitutions": `const key = \`${KEY}\`;`,
} as const;

/** What the header of `support/proofReferences.ts` lists as not seen. A reviewer reads these; the scan does not. */
const BLIND_SPOTS = {
  "Q: a plain generator's yield*": `import { InTransaction } from "@vektorprogrammet/domain";
function* leak() { yield* InTransaction; }
const key = leak().next().value;`,
  "a context captured inside a transaction and provided later": `const capture = Effect.context();
const later = (program) => Effect.provide(program, captured);`,
  "a key built from parts": `const key = "@vektorprogrammet/domain/" + "shared/InTran" + "saction";`,
  "a runtime-built member name": `import * as D from "@vektorprogrammet/domain";
const name = ["In", "Transaction"].join("");
const proof = D[name as keyof typeof D];`,
  "the namespace read under a runtime key": `import * as D from "@vektorprogrammet/domain";
const all = Object.values(D);`,
} as const;

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

  it("falsifier 6, control: the forgeries of round 3 that hold the key as a whole string, and the Unicode escapes, are found", () => {
    for (const [name, source] of Rec.toEntries(ROUND_THREE)) {
      assert.isAbove(referencesIn(source), 0, name);
    }
  });

  it("falsifier 6, control: a type that is a string literal of the key is not a reference", () => {
    assert.strictEqual(
      referencesIn(`type K = "${KEY}"; const o = { "${KEY}": 1 }; `),
      1,
      "the key as a type is not a reference, the key as a written string is"
    );
  });

  it("falsifier 6, documented blind spots: the forms that the header names are not found (if the scan learns one, move it above and edit the header)", () => {
    for (const [name, source] of Rec.toEntries(BLIND_SPOTS)) {
      assert.strictEqual(referencesIn(source), 0, name);
    }
  });

  it.effect(
    "falsifier 6, control: the scan reads the working tree through git, so an ignored build output is not read and an untracked source file is",
    () =>
      Effect.gen(function* listsThroughGit() {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tree = yield* fs.makeTempDirectoryScoped();
        yield* spawner.string(gitIn(tree, ["init", "-q"]));

        const where = yield* Path.Path;

        const write = (file: string, text: string) =>
          Effect.andThen(
            fs.makeDirectory(where.dirname(`${tree}/${file}`), {
              recursive: true,
            }),
            fs.writeFileString(`${tree}/${file}`, text)
          );

        // The repository's own `.gitignore` ignores these; so does this one. The first path is the one that failed the
        // scan in a checkout that had run the db-path spike (round 3, finding 3).
        yield* write(
          ".gitignore",
          ".alchemy/\n.wrangler/\ndist/\nnode_modules/\n"
        );
        yield* write(
          "tools/db-path-spike/.alchemy/bundles/vp-spike-0000-spike-Worker/worker.js",
          FORGERIES["A: an aliased import, provideService"]
        );
        yield* write(
          "apps/cms/.wrangler/tmp/bundle.ts",
          FORGERIES["B: provideServiceEffect"]
        );
        yield* write(
          "apps/web/dist/server/index.js",
          FORGERIES["E: parentheses"]
        );
        yield* write(
          "packages/x/node_modules/y/index.js",
          FORGERIES["F: a tuple destructuring"]
        );
        yield* write(
          "packages/x/src/untracked.ts",
          FORGERIES["C: InTransaction as typeof InTransaction"]
        );

        const read = yield* workingTreeSources(tree, (path) =>
          sourcePattern.test(path)
        );

        assert.deepStrictEqual(
          Arr.map(read, ({ path }) => path),
          ["packages/x/src/untracked.ts"]
        );
        assert.isAbove(
          referencesIn(read[0]?.text ?? ""),
          0,
          "the untracked source file is read, and its forgery is found"
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000
  );

  it.effect(
    "falsifier 6: only the allowed files hold InTransaction as a value, with the number of places each allows",
    () =>
      Effect.gen(function* fewProviders() {
        const sources = yield* workingTreeSources(
          root,
          (path) =>
            /^(?:apps|packages|tools)\//u.test(path) && sourcePattern.test(path)
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
    // A two-CPU runner parses the tracked source files (about 650) and lists them through git.
    60_000
  );
});
