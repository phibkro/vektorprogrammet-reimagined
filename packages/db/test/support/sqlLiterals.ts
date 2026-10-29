/**
 * The text that a source file writes as string and template literals (spec 0025, decision D6), each with the line it
 * starts on. A placeholder of a template (`${…}`) is a ` ? `.
 *
 * Every string literal and every template literal is returned, and `statement` says whether it stands where a program
 * hands a statement to something: a template with any tag (`sql`, `this.sql`, a renamed tag), or the first argument of any
 * call or `new` (`client.unsafe(…)`, `pool.query(…)`, `client.exec(…)`, `sql.raw(…)`). Anything else (a constant, an object
 * field, an array item) is only text: it may be a statement, and it may be a sentence. `findingsIn` reads a `statement`
 * with the whole classifier and any other text with the constructs that cannot be a word of prose.
 *
 * What it cannot see: a statement built from parts at run time (the parts are read, the whole is not), a statement read
 * from a file or the environment, an opening word (`listen`, `set`, `prepare`, `load`, `notify`) in a plain constant, and
 * Drizzle's builder (which cannot write an advisory lock, a `LISTEN` or a session `SET`: those need text).
 */
import { Array as Arr, Predicate } from "effect";
import { Visitor, parseSync } from "oxc-parser";

import { constructFacts } from "../../src/platform/constructs.ts";
import type { DirectOnlyConstruct } from "../../src/platform/constructs.ts";
import { forbiddenConstructsOf } from "../../src/platform/statements.ts";

export interface SourceText {
  readonly line: number;
  readonly text: string;
  /** Where a program hands a statement over (a tagged template, the first argument of a call), or only text. */
  readonly statement: boolean;
}

interface Quasi {
  readonly value: {
    readonly cooked?: string | null | undefined;
    readonly raw: string;
  };
}

const textOfTemplate = (quasis: readonly Quasi[]): string =>
  Arr.join(
    Arr.map(quasis, (quasi) => quasi.value.cooked ?? quasi.value.raw),
    " ? "
  );

const lineAt = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;

/** Every string and template literal in a TypeScript source, in the order of the file. */
export const textsIn = (
  path: string,
  source: string
): readonly SourceText[] => {
  const found: SourceText[] = [];
  const statements = new Set<number>();

  const { program } = parseSync(path, source);

  new Visitor({
    CallExpression(node) {
      const [first] = node.arguments;

      if (first !== undefined) {
        statements.add(first.start);
      }
    },
    Literal(node) {
      if (Predicate.isString(node.value)) {
        found.push({
          line: lineAt(source, node.start),
          statement: statements.has(node.start),
          text: node.value,
        });
      }
    },
    NewExpression(node) {
      const [first] = node.arguments;

      if (first !== undefined) {
        statements.add(first.start);
      }
    },
    TaggedTemplateExpression(node) {
      statements.add(node.quasi.start);
    },
    TemplateLiteral(node) {
      found.push({
        line: lineAt(source, node.start),
        statement: statements.has(node.start),
        text: textOfTemplate(node.quasis),
      });
    },
  }).visit(program);

  return found;
};

/** The constructs that no sentence of prose is: a function name, a keyword pair. The others open a statement (`listen`, `set`). */
const proseCannotBe = (construct: DirectOnlyConstruct): boolean =>
  !["listen", "notify", "set-session", "sql-prepare", "load"].includes(
    construct
  );

const findingOf = (
  path: string,
  line: number,
  construct: DirectOnlyConstruct
): string => {
  const fact = constructFacts[construct];

  return `${path}:${line}: ${construct} (Hyperdrive: ${fact.hyperdrive.outcome}, ${fact.hyperdrive.how}; pg-txmode row: ${fact.pgTxmodeRow ?? "none"})`;
};

/**
 * What a file uses that Hyperdrive does not take, each with the file, the line, the construct and its catalogue row. A
 * migration is one statement text; a TypeScript file is read for every string and template literal (`textsIn`): one that
 * stands where a statement is handed over is read whole, any other only for the constructs that cannot be prose.
 */
export const findingsIn = (path: string, source: string): readonly string[] =>
  Arr.flatMap(
    path.endsWith(".sql")
      ? [{ line: 1, statement: true, text: source }]
      : textsIn(path, source),
    ({ line, statement, text }) =>
      Arr.map(
        statement
          ? forbiddenConstructsOf(text)
          : Arr.filter(forbiddenConstructsOf(text), proseCannotBe),
        (construct) => findingOf(path, line, construct)
      )
  );
