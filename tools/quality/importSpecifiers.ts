import { Array as Arr, Option, Predicate } from "effect";
import { parseSync } from "oxc-parser";

/** One module specifier written in a source file, with the line it starts on. */
export interface Specifier {
  readonly line: number;
  readonly specifier: string;
}

const stringLiteral = /^(?<quote>["'`])(?<value>[^"'`$]*)\k<quote>$/u;

/** The specifier of an `import(…)` whose argument is a plain string; a computed one is not a specifier a check can read. */
const literalOf = (argument: string): Option.Option<string> =>
  Option.fromNullishOr(stringLiteral.exec(argument.trim())?.groups?.value);

/**
 * Every static `import`, `export … from` and `import("…")` with a literal argument in `text`, the file `path` (its
 * extension picks the parser's language). Text that only mentions a package (a string, a comment) is not an import.
 * `checkStoreBoundary.ts` and `checkModuleGraph.ts` read the imports of the repository through this one function.
 */
export const importSpecifiers = (
  path: string,
  text: string
): readonly Specifier[] => {
  const { module } = parseSync(path, text);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

  const requests = [
    ...Arr.map(module.staticImports, ({ moduleRequest }) => moduleRequest),
    ...Arr.flatMap(module.staticExports, ({ entries }) =>
      Arr.flatMap(entries, ({ moduleRequest }) =>
        Predicate.isNotNull(moduleRequest) ? [moduleRequest] : []
      )
    ),
    ...Arr.flatMap(module.dynamicImports, ({ moduleRequest }) =>
      Option.match(
        literalOf(text.slice(moduleRequest.start, moduleRequest.end)),
        {
          onNone: () => [],
          onSome: (value) => [{ ...moduleRequest, value }],
        }
      )
    ),
  ];

  return Arr.map(requests, (request) => ({
    line: lineOf(request.start),
    specifier: request.value,
  }));
};

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
