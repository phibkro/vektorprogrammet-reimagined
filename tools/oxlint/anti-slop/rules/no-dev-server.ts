import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

/** A word of a command; `null` stands for a word that is not static text. */
type Word = string | null;

// The Vite and React Router CLIs, by name or by entry path.
const devServerProgram =
  /(?:^|\/)(?:vite|react-router|@react-router\/dev\/dist\/cli\/index\.js|vite\/bin\/vite\.js)$/u;

function staticText(node: ESTree.Node | null | undefined): Word {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal")
    return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function words(nodes: ReadonlyArray<ESTree.Node | null>): Array<Word> {
  return nodes.map((node) => staticText(node));
}

/** The words of a command line; each interpolation is one non-static word. */
function shellWords(quasis: ReadonlyArray<string>): Array<Word> {
  return quasis.flatMap((text, index) => [
    ...text.split(/\s+/u).filter((word) => word.length > 0),
    ...(index < quasis.length - 1 ? [null] : []),
  ]);
}

/**
 * The dev server command in a word sequence, if any: a Vite or React Router CLI followed by
 * `dev` or `serve`, or a package manager's `run dev`, whose `dev` script is such a CLI.
 */
function devServerCommand(sequence: ReadonlyArray<Word>): string | null {
  for (let index = 0; index + 1 < sequence.length; index += 1) {
    const program = sequence[index];
    const command = sequence[index + 1];
    if (
      program === null ||
      program === undefined ||
      command === null ||
      command === undefined
    ) {
      continue;
    }
    // `vite serve` is an alias of `vite dev`.
    if (
      devServerProgram.test(program) &&
      (command === "dev" || command === "serve")
    ) {
      return `${program} ${command}`;
    }
    if (program === "run" && command === "dev") return "run dev";
  }
  return null;
}

/**
 * Reject a Vite dev server in journey code and Playwright configs. A dev server optimizes each
 * dependency that it first meets while a test runs, then reloads the page, which aborts the
 * test's navigation on a cold cache (hosted runs 36239270833 and 36239753596). A check builds
 * the app from the current source and serves that build.
 */
export const noDevServerRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a Vite dev server in journey code, which reloads the page while a test navigates.",
    },
    messages: {
      devServer:
        "`{{command}}` starts a Vite dev server, which re-optimizes dependencies and reloads the page under a navigating test. Build the app from the current source and serve the build.",
    },
  },
  createOnce(context) {
    const check = (
      node: ESTree.Node,
      sequence: ReadonlyArray<Word>
    ): boolean => {
      const command = devServerCommand(sequence);
      if (command === null) return false;
      context.report({ node, messageId: "devServer", data: { command } });
      return true;
    };

    return {
      CallExpression(node) {
        // spawn("vite", ["dev"]): the program and its arguments are separate. The argument
        // array alone is checked by ArrayExpression, so only a match that needs the program is new.
        const [first, second] = node.arguments;
        if (second?.type !== "ArrayExpression") return;
        const program = staticText(first);
        const argumentsOfProgram = words(second.elements);
        if (program === null || devServerCommand(argumentsOfProgram) !== null)
          return;
        check(second, [program, ...argumentsOfProgram]);
      },
      ArrayExpression(node) {
        // spawn("node", ["node_modules/@react-router/dev/dist/cli/index.js", "dev"]).
        check(node, words(node.elements));
      },
      Literal(node) {
        // command: "bun run dev --host 127.0.0.1".
        if (typeof node.value === "string")
          check(node, shellWords([node.value]));
      },
      TemplateLiteral(node) {
        // `vite dev --port ${port}`.
        check(
          node,
          shellWords(node.quasis.map((quasi) => quasi.value.cooked ?? ""))
        );
      },
    };
  },
});
