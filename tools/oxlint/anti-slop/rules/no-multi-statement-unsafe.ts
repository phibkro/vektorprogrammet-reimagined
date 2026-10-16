import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

// Dollar-quoted bodies, comments, quoted strings, and quoted identifiers hide their semicolons.
const HIDDEN_TEXT =
  /\$([A-Za-z_]*)\$[\s\S]*?\$\1\$|\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"/gu;

/** The SQL text of a string or template literal, with each `${...}` hole spelled as one word. */
function sqlText(node: ESTree.Node | undefined): string | null {
  if (node === undefined) return null;
  if (node.type === "Literal")
    return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    return node.quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
      .join("hole");
  }
  return null;
}

/** The number of commands in SQL text: its non-empty pieces between top-level semicolons. */
function commandCount(text: string): number {
  return text
    .replace(HIDDEN_TEXT, " ")
    .split(";")
    .filter((piece) => piece.trim() !== "").length;
}

/** Ban a multi-statement text as the argument of `.unsafe(...)`, which the native client refuses. */
export const noMultiStatementUnsafeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow SQL text with more than one command as the first argument of `.unsafe(...)`: the native PostgreSQL client runs one statement per execution, and the server answers `cannot insert multiple commands into a prepared statement`.",
    },
    messages: {
      multipleCommands:
        "This `.unsafe(...)` text holds more than one SQL command. The native client runs one statement per execution, so PostgreSQL rejects the text only at run time. Give each command its own call, or run a multi-statement source with `executePostgresMigration` inside `sql.withTransaction`.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          !("property" in callee) ||
          !("computed" in callee) ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "unsafe"
        )
          return;
        const [argument] = node.arguments;
        const text = sqlText(argument);
        if (argument !== undefined && text !== null && commandCount(text) > 1) {
          context.report({ node: argument, messageId: "multipleCommands" });
        }
      },
    };
  },
});
