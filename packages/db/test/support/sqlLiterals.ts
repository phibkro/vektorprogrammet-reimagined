/**
 * The SQL that a source file writes (spec 0025, decision D6): the text of every `sql` tagged template and of the first
 * argument of `.unsafe(…)` and `.raw(…)`, each with the line it starts on. A placeholder of a template (`${…}`) is a `?`.
 * A statement that a program builds from parts at run time is not seen, and neither is Drizzle's builder (which cannot
 * write an advisory lock, a `LISTEN` or a session `SET`: those need `sql` text, and the text is read here).
 */
import { Array as Arr, Predicate } from "effect";
import { Visitor, parseSync } from "oxc-parser";
import type { Expression } from "oxc-parser";

export interface SqlText {
  readonly line: number;
  readonly text: string;
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

/** Whether an expression is the name `sql`, or a member that ends in it (`this.sql`, `client.sql`). */
const isSqlTag = (tag: Expression): boolean =>
  (tag.type === "Identifier" && tag.name === "sql") ||
  (tag.type === "MemberExpression" &&
    tag.property.type === "Identifier" &&
    tag.property.name === "sql");

/** Every SQL text in a TypeScript source, in the order of the file. */
export const sqlTextsIn = (
  path: string,
  source: string
): readonly SqlText[] => {
  const found: SqlText[] = [];

  const { program } = parseSync(path, source);

  new Visitor({
    CallExpression(node) {
      const { callee } = node;

      if (
        callee.type !== "MemberExpression" ||
        callee.property.type !== "Identifier" ||
        !["raw", "unsafe"].includes(callee.property.name)
      ) {
        return;
      }

      const [first] = node.arguments;

      if (first?.type === "Literal" && Predicate.isString(first.value)) {
        found.push({ line: lineAt(source, node.start), text: first.value });
      } else if (first?.type === "TemplateLiteral") {
        found.push({
          line: lineAt(source, node.start),
          text: textOfTemplate(first.quasis),
        });
      }
    },
    TaggedTemplateExpression(node) {
      if (isSqlTag(node.tag)) {
        found.push({
          line: lineAt(source, node.start),
          text: textOfTemplate(node.quasi.quasis),
        });
      }
    },
  }).visit(program);

  return found;
};
