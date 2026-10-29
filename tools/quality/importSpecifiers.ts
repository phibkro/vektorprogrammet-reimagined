import { Array as Arr, Option, Order, Predicate, String as Str } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type { Argument, Program } from "oxc-parser";

/** One module specifier written in a source file, with the line it starts on. */
export interface Specifier {
  readonly line: number;
  readonly specifier: string;
}

/** An `import.meta.glob(…)` that the check can read: its patterns are plain strings and its options are the allowed ones. */
interface GlobImport {
  readonly line: number;
  readonly patterns: readonly string[];
}

/**
 * An `import(…)` or `import.meta.glob(…)` that no check can place: its argument is not a plain string, or (`reason`) it is
 * a glob that the check refuses to place and says why.
 */
export interface ComputedImport {
  readonly line: number;
  readonly reason?: string;
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
  Option.fromNullishOr(stringLiteral.exec(Str.trim(argument))?.groups?.value);

/** What the syntax-tree walk finds that the parser's own list of imports and exports leaves out, as `[start, …]`. */
interface Walked {
  readonly computedGlobs: readonly (readonly [
    number,
    string,
    string | undefined,
  ])[];
  readonly globs: readonly (readonly [number, readonly string[]])[];
  readonly specifiers: readonly (readonly [number, string])[];
}

/** A string whose source text holds a backslash is an escape: the check reads source text and Vite reads the value. */
const escapes = (raw: string): boolean => Str.includes("\\")(raw);

/** The option keys that `import.meta.glob` may be given here. Anything else (`base`, `exhaustive`, `caseSensitive`, `__proto__`, …) changes what the glob loads or runs code. */
const allowedOptions: ReadonlySet<string> = new Set([
  "eager",
  "import",
  "query",
]);

const plainValue = /^(?:true|false|"[^"\\]*"|'[^'\\]*')$/u;

/**
 * Why the options argument of `import.meta.glob` is not allowed, or none when it is: absent, or an object literal whose
 * properties are all plain `key: value` pairs (no spread, computed key, shorthand or method) whose keys are `eager`,
 * `import` or `query` and whose values are a boolean or a string literal without a backslash.
 */
const optionsRefusal = (
  options: Argument | undefined,
  text: string
): string | undefined => {
  if (options === undefined) {
    return undefined;
  }

  if (options.type !== "ObjectExpression") {
    return "its options are not an object literal";
  }

  for (const property of options.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.computed ||
      property.shorthand ||
      property.method
    ) {
      return "its options hold a spread, computed key, shorthand or method";
    }

    const key = Str.slice(property.key.start, property.key.end)(text);

    if (!allowedOptions.has(Str.replaceAll(/^["']|["']$/gu, "")(key))) {
      return `its option ${key} is not one of eager, import and query`;
    }

    if (
      !plainValue.test(
        Str.slice(property.value.start, property.value.end)(text)
      )
    ) {
      return `the value of its option ${key} is not a boolean or a plain string`;
    }
  }

  return undefined;
};

/** What an `import.meta.glob(…)` call comes to: patterns that the check can place, or a load that it cannot. */
type GlobForm =
  | { readonly kind: "glob"; readonly patterns: readonly string[] }
  | {
      readonly kind: "computed";
      readonly reason: string | undefined;
      readonly written: string;
    };

/** The patterns and options of one `import.meta.glob(…)` call, from the text of its arguments. */
const globForm = (args: readonly Argument[], text: string): GlobForm => {
  const [first, second] = args;
  const last = args.at(-1);

  const written =
    first === undefined || last === undefined
      ? ""
      : Str.slice(first.start, last.end)(text);

  const patternText =
    first === undefined ? "" : Str.slice(first.start, first.end)(text);

  const elements =
    first?.type === "ArrayExpression"
      ? Arr.map(first.elements, (element) =>
          Option.flatMap(Option.fromNullishOr(element), ({ end, start }) =>
            literalOf(Str.slice(start, end)(text))
          )
        )
      : [literalOf(patternText)];

  const patterns = Arr.getSomes(elements);

  if (patterns.length !== elements.length || patterns.length === 0) {
    return { kind: "computed", reason: undefined, written };
  }

  const reason = escapes(patternText)
    ? "its pattern is written with an escape (a backslash): the check reads the source text and Vite the string it spells"
    : optionsRefusal(second, text);

  if (args.length > 2) {
    return {
      kind: "computed",
      reason: "it has more than two arguments",
      written,
    };
  }

  return reason === undefined
    ? { kind: "glob", patterns }
    : { kind: "computed", reason, written };
};

/**
 * The nodes that `module` (the parser's list of imports and exports) leaves out: the type-level `import("…")`
 * (`typeof import("./x.ts")`, `import("./x.ts").T`, a `TSImportType`), `import x = require("…")` (also `import type`
 * and `export import`), a string-named `declare module "…"` (it augments the module that the string names), and
 * `import.meta.glob(…)`, whose patterns are read when they are plain strings.
 */
const walked = (program: Program, text: string): Walked => {
  const specifiers: (readonly [number, string])[] = [];

  const globs: (readonly [number, readonly string[]])[] = [];

  const computedGlobs: (readonly [number, string, string | undefined])[] = [];

  new Visitor({
    CallExpression(node) {
      const callee = Str.replaceAll(
        /\s+/gu,
        ""
      )(Str.slice(node.callee.start, node.callee.end)(text));

      if (callee !== "import.meta.glob") {
        return;
      }

      const form = globForm(node.arguments, text);

      if (form.kind === "glob") {
        globs.push([node.start, form.patterns]);
      } else {
        computedGlobs.push([
          node.start,
          `import.meta.glob(${form.written})`,
          form.reason,
        ]);
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

  const lineOf = (offset: number) =>
    Str.split(Str.slice(0, offset)(text), "\n").length;

  const found = walked(program, text);

  const dynamic = Arr.map(module.dynamicImports, ({ moduleRequest }) => ({
    start: moduleRequest.start,
    value: literalOf(Str.slice(moduleRequest.start, moduleRequest.end)(text)),
    written: Str.slice(moduleRequest.start, moduleRequest.end)(text),
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
      ...Arr.map(
        found.computedGlobs,
        ([start, written, reason]): ComputedImport =>
          reason === undefined
            ? { line: lineOf(start), text: written }
            : { line: lineOf(start), reason, text: written }
      ),
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
      Str.split(specifier, "/"),
      Arr.dropRight(Str.split(importer, "/"), 1),
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
