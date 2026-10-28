import { Array as Arr, Option, Order, Predicate } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";

/** One module specifier written in a source file, with the line it starts on. */
export interface Specifier {
  readonly line: number;
  readonly specifier: string;
}

/** An `import.meta.glob(…)` whose patterns are all plain strings: each pattern names every file that it matches. */
interface GlobImport {
  readonly line: number;
  readonly patterns: readonly string[];
}

/** An `import(…)` or `import.meta.glob(…)` whose argument is not a plain string, so no check can say what it loads. */
export interface ComputedImport {
  readonly line: number;
  readonly text: string;
}

/** Everything in a file that loads another module, by how much of it a check can read. */
export interface ImportForms {
  readonly computed: readonly ComputedImport[];
  readonly globs: readonly GlobImport[];
  readonly specifiers: readonly Specifier[];
}

const stringLiteral = /^(?<quote>["'`])(?<value>[^"'`$]*)\k<quote>$/u;

/** The value of an argument written as a plain string; a computed one (a template with `${}`, a name) has none. */
const literalOf = (argument: string): Option.Option<string> =>
  Option.fromNullishOr(stringLiteral.exec(argument.trim())?.groups?.value);

/** What the syntax-tree walk finds that the parser's own list of imports and exports leaves out, as `[start, …]`. */
interface Walked {
  readonly computedGlobs: readonly (readonly [number, string])[];
  readonly globs: readonly (readonly [number, readonly string[]])[];
  readonly specifiers: readonly (readonly [number, string])[];
}

/**
 * The nodes that `module` (the parser's list of imports and exports) leaves out: the type-level `import("…")`
 * (`typeof import("./x.ts")`, `import("./x.ts").T`, a `TSImportType`), `import x = require("…")` (also `import type`
 * and `export import`), a string-named `declare module "…"` (it augments the module that the string names), and
 * `import.meta.glob(…)`, whose patterns are read when they are plain strings.
 */
const walked = (program: Program, text: string): Walked => {
  const specifiers: (readonly [number, string])[] = [];
  const globs: (readonly [number, readonly string[]])[] = [];
  const computedGlobs: (readonly [number, string])[] = [];

  new Visitor({
    CallExpression(node) {
      const callee = text
        .slice(node.callee.start, node.callee.end)
        .replaceAll(/\s+/gu, "");

      if (callee !== "import.meta.glob") {
        return;
      }

      const [first] = node.arguments;

      const written =
        first === undefined ? "" : text.slice(first.start, first.end);

      const elements =
        first?.type === "ArrayExpression"
          ? Arr.map(first.elements, (element) =>
              Option.flatMap(Option.fromNullishOr(element), ({ end, start }) =>
                literalOf(text.slice(start, end))
              )
            )
          : [literalOf(written)];

      const patterns = Arr.getSomes(elements);

      if (patterns.length === elements.length && patterns.length > 0) {
        globs.push([node.start, patterns]);
      } else {
        computedGlobs.push([node.start, `import.meta.glob(${written})`]);
      }
    },
    TSImportEqualsDeclaration({ moduleReference }) {
      if (moduleReference.type === "TSExternalModuleReference") {
        specifiers.push([
          moduleReference.expression.start,
          moduleReference.expression.value,
        ]);
      }
    },
    TSImportType({ source }) {
      // A computed argument is a parse recovery with an empty string: no specifier.
      if (source.value !== "") {
        specifiers.push([source.start, source.value]);
      }
    },
    TSModuleDeclaration({ id }) {
      if (id.type === "Literal") {
        specifiers.push([id.start, id.value]);
      }
    },
  }).visit(program);

  return { computedGlobs, globs, specifiers };
};

const byLine = <A extends { readonly line: number }>(items: readonly A[]) =>
  Arr.sort(
    items,
    Order.mapInput(Order.Number, ({ line }: A) => line)
  );

/**
 * Every way that `text`, the file `path` (its extension picks the parser's language), loads another module, in the order
 * of the file: the specifiers (a static `import`, `export … from`, `import("…")` with a plain string, a type-level
 * `import("…")`, `import x = require("…")`, a string-named `declare module "…"`), the `import.meta.glob(…)` calls with
 * plain patterns, and the `import(…)` and `import.meta.glob(…)` calls whose argument is computed. Text that only
 * mentions a package (a string, a comment) is none of these. `checkStoreBoundary.ts` reads the specifiers through
 * `importSpecifiers`; `checkModuleGraph.ts` reads all three.
 */
export const importForms = (path: string, text: string): ImportForms => {
  const { module, program } = parseSync(path, text);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const found = walked(program, text);

  const dynamic = Arr.map(module.dynamicImports, ({ moduleRequest }) => ({
    start: moduleRequest.start,
    value: literalOf(text.slice(moduleRequest.start, moduleRequest.end)),
    written: text.slice(moduleRequest.start, moduleRequest.end),
  }));

  const requests = [
    ...Arr.map(module.staticImports, ({ moduleRequest }) => moduleRequest),
    ...Arr.flatMap(module.staticExports, ({ entries }) =>
      Arr.flatMap(entries, ({ moduleRequest }) =>
        Predicate.isNotNull(moduleRequest) ? [moduleRequest] : []
      )
    ),
    ...Arr.flatMap(dynamic, ({ start, value }) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (plain) => [{ start, value: plain }],
      })
    ),
    ...Arr.map(found.specifiers, ([start, value]) => ({ start, value })),
  ];

  return {
    computed: byLine([
      ...Arr.flatMap(dynamic, ({ start, value, written }) =>
        Option.isNone(value)
          ? [{ line: lineOf(start), text: `import(${written})` }]
          : []
      ),
      ...Arr.map(found.computedGlobs, ([start, written]) => ({
        line: lineOf(start),
        text: written,
      })),
    ]),
    globs: byLine(
      Arr.map(found.globs, ([start, patterns]) => ({
        line: lineOf(start),
        patterns,
      }))
    ),
    specifiers: byLine(
      Arr.map(requests, (request) => ({
        line: lineOf(request.start),
        specifier: request.value,
      }))
    ),
  };
};

/** The specifiers of `text` (see `importForms`): the imports whose target is a name. */
export const importSpecifiers = (
  path: string,
  text: string
): readonly Specifier[] => importForms(path, text).specifiers;

/** `specifier`, a relative path written in the file `importer`, as a path from the repository root. */
export const resolveFrom = (importer: string, specifier: string): string =>
  Arr.join(
    Arr.reduce(
      specifier.split("/"),
      Arr.dropRight(importer.split("/"), 1),
      (parts, segment) => {
        if (segment === ".") {
          return parts;
        }

        return segment === ".."
          ? Arr.dropRight(parts, 1)
          : Arr.append(parts, segment);
      }
    ),
    "/"
  );
