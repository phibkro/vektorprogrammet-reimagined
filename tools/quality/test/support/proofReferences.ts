/**
 * Every place of a source text that holds the domain's `InTransaction` as a value, or its key as a string (spec 0018,
 * falsifier 6, guarantee TX5).
 *
 * **This is a guard against accidental misuse, not a proof that the proof cannot be forged.** `InTransaction` is an
 * ordinary value, and Effect keys a service by a string: a `Context` entry is the pair of that string and a value, and
 * a service "key" is nothing but `{ key: "<the string>" }`. So a program can make the proof without naming the service
 * at all, and no scan of the source can close that. What the scan does is make the careless and the convenient
 * spellings fail the test: a second provider written by someone who did not know the rule, in whatever clothes. The
 * unforgeable construction is a check at run time that the proof is the live transaction's own, as a lock token is
 * (`Locked`, spec 0006b); that is a later spec (R20 of spec 0018 names it).
 *
 * The scan does not list the ways to provide (`provideService`, `Layer.succeed`, `provideServiceEffect`, ...). It flags
 * every reference to the service as a value, except the ones that only read it. A reference is an identifier that
 * names the service (`InTransaction`, or the local name that an import or a destructuring gives it, escapes in the
 * name included: the parser reads `\u0049nTransaction` as the name), a member access or a destructured key that names
 * it (`Domain.InTransaction`, `Domain["InTransaction"]`, `{ InTransaction: Proof } = Domain`), an export of it under
 * another name, and a string or a template without substitutions that is the service's key. Wrappers cannot hide a
 * reference, because the scan looks at the identifier and not at the expression around it: `(InTransaction)`,
 * `InTransaction as typeof InTransaction`, `InTransaction satisfies ...`, `InTransaction!`, `<T>InTransaction`,
 * `{ proof: InTransaction }`, `[InTransaction]`, `cond ? InTransaction : other`, a spread, a default export.
 *
 * Not references: `yield* InTransaction` (a program that requires the proof reads it), a type position (an
 * annotation, a type argument, `typeof InTransaction` in a type, `implements`, `extends`, a string literal type), the
 * import and export declarations themselves (an export under the same name, a type-only import), a declaration that
 * happens to be named the same, and a property key such as `{ InTransaction: "..." }`.
 *
 * **What it does not see** (a reviewer reads these; three rounds of review found each):
 * - a key that is not written as one whole string: built from parts (`"@vektorprogrammet/domain/" + "shared/…"`), read
 *   from a file or the environment, or taken from a dependency that holds it;
 * - the plain generator's `yield*`: `function* () { yield* InTransaction }` is exempt like `Effect.gen`'s, and a plain
 *   generator's `next().value` is the service;
 * - a name that is built at run time (`Domain[name]`, `Object.values(Domain)`, `Reflect.get`) and a namespace handed
 *   on and read elsewhere under a runtime key;
 * - a `Context` captured inside a transaction (`Effect.context()`) and provided after it has ended: that is the real
 *   proof, used late, and it needs no reference to the service;
 * - a cast object that has the key (`{ key } as unknown as typeof InTransaction`) when the key is not a whole literal.
 */
import { InTransaction } from "@vektorprogrammet/domain";
import { Array as Arr, Predicate, Record as Rec } from "effect";
import { Visitor, parseSync, visitorKeys } from "oxc-parser";
import type {
  Expression,
  ModuleExportName,
  PropertyKey,
  VisitorObject,
} from "oxc-parser";

const SERVICE = "InTransaction";

/** The string that Effect keys the service by. A key is only this string, which is why a source scan cannot stop a forgery. */
const SERVICE_KEY: string = InTransaction.key;

/** A TypeScript node that is not a type: it holds a value, or it is a name that this scan reads itself. */
const NOT_TYPES = new Set([
  "TSAbstractAccessorProperty",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "TSAsExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "TSEnumBody",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSExportAssignment",
  "TSExternalModuleReference",
  "TSImportEqualsDeclaration",
  "TSInstantiationExpression",
  "TSModuleBlock",
  "TSModuleDeclaration",
  "TSNamespaceExportDeclaration",
  "TSNonNullExpression",
  "TSParameterProperty",
  "TSQualifiedName",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The type nodes, and with them whether the visitor is inside a type. */
const typeNodes = Arr.filter(
  Rec.keys(visitorKeys),
  (type) => type.startsWith("TS") && !NOT_TYPES.has(type)
);

/** The text that a name, a string literal or a template without substitutions gives; `undefined` for anything else. */
const nameOf = (
  node: Expression | ModuleExportName | PropertyKey | null | undefined
): string | undefined => {
  if (node === null || node === undefined) {
    return undefined;
  }

  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "Literal") {
    return Predicate.isString(node.value) ? node.value : undefined;
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
};

/** What wraps a value without changing it: parentheses and the TypeScript assertions. */
const unwrapped = (node: Expression): Expression =>
  node.type === "ParenthesizedExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "TSTypeAssertion"
    ? unwrapped(node.expression)
    : node;

/** A node by where it stands: two member expressions never start and end at the same offsets. */
const spanOf = (node: { readonly start: number; readonly end: number }) =>
  `${node.start}:${node.end}`;

/**
 * The local names that give the service in this file: its own name, what an import calls it, what a destructuring
 * calls it. A first pass, because an import may stand below the code that uses it.
 */
const namesFor = (program: ReturnType<typeof parseSync>["program"]) => {
  const names = new Set<string>([SERVICE]);

  new Visitor({
    ImportSpecifier(node) {
      if (nameOf(node.imported) === SERVICE) {
        names.add(node.local.name);
      }
    },
    ObjectPattern(node) {
      for (const property of node.properties) {
        if (
          property.type === "Property" &&
          !property.computed &&
          nameOf(property.key) === SERVICE
        ) {
          const target =
            property.value.type === "AssignmentPattern"
              ? property.value.left
              : property.value;

          if (target.type === "Identifier") {
            names.add(target.name);
          }
        }
      }
    },
  }).visit(program);

  return names;
};

/**
 * The lines of `text` that hold the service as a value. `path` names the language for the parser. Every file is parsed:
 * a text pre-filter on the word would skip a file that writes the name with a Unicode escape (`\u0049nTransaction`),
 * which the parser reads as the name. (The scan once skipped files by that filter because it listed the whole tree,
 * `node_modules` included; it now lists the working tree through git, and parses its source files in a second or two.)
 */
export const proofReferences = (
  path: string,
  text: string
): readonly number[] => {
  const { program } = parseSync(path, text);
  const names = namesFor(program);
  const found: number[] = [];
  const skipped = new Set<number>();
  const reading = new Set<string>();
  const depth = { inType: 0 };

  const hold = (at: { readonly start: number }) => {
    found.push(text.slice(0, at.start).split("\n").length);
  };

  /** What is named by the node at `start` is not a reference: a key, a binding, a specifier. */
  const skip = (...at: readonly ({ readonly start: number } | null)[]) => {
    for (const node of at) {
      if (node !== null) {
        skipped.add(node.start);
      }
    }
  };

  const enter = () => {
    depth.inType += 1;
  };

  const exit = () => {
    depth.inType -= 1;
  };

  const typeVisitor = Rec.fromEntries(
    Arr.flatMap(typeNodes, (type) => [
      [type, enter] as const,
      [`${type}:exit`, exit] as const,
    ])
  );

  /** A class or an object member is named by its key, which is a reference only when it is computed. */
  const keyed = (node: {
    readonly computed: boolean;
    readonly key: PropertyKey;
  }) => {
    if (!node.computed) {
      skip(node.key);
    }
  };

  const visitor: VisitorObject = {
    AccessorProperty: keyed,
    ClassDeclaration(node) {
      skip(node.id);
    },
    ClassExpression(node) {
      skip(node.id);
    },
    ExportSpecifier(node) {
      skip(node.local, node.exported);

      if (
        names.has(nameOf(node.local) ?? "") &&
        nameOf(node.exported) !== SERVICE
      ) {
        hold(node);
      }
    },
    FunctionDeclaration(node) {
      skip(node.id);
    },
    FunctionExpression(node) {
      skip(node.id);
    },
    Identifier(node) {
      if (
        depth.inType === 0 &&
        names.has(node.name) &&
        !skipped.has(node.start)
      ) {
        hold(node);
      }
    },
    ImportDefaultSpecifier(node) {
      skip(node.local);
    },
    ImportNamespaceSpecifier(node) {
      skip(node.local);
    },
    ImportSpecifier(node) {
      skip(node.local, node.imported);
    },
    Literal(node) {
      if (depth.inType === 0 && node.value === SERVICE_KEY) {
        hold(node);
      }
    },
    MemberExpression(node) {
      if (!node.computed) {
        skip(node.property);
      }

      const named = node.computed ? nameOf(node.property) : node.property.name;

      if (
        named === SERVICE &&
        depth.inType === 0 &&
        !reading.has(spanOf(node))
      ) {
        hold(node);
      }
    },
    MethodDefinition: keyed,
    ObjectExpression(node) {
      for (const property of node.properties) {
        if (property.type !== "Property") {
          continue;
        }

        if (property.shorthand) {
          if (names.has(nameOf(property.value) ?? "")) {
            hold(property);
          }

          skip(property.key, property.value);
        } else if (!property.computed) {
          skip(property.key);
        }
      }
    },
    ObjectPattern(node) {
      for (const property of node.properties) {
        if (property.type !== "Property") {
          continue;
        }

        if (!property.computed && nameOf(property.key) === SERVICE) {
          hold(property);
        }

        skip(
          property.key,
          property.value.type === "AssignmentPattern"
            ? property.value.left
            : property.value
        );
      }
    },
    PropertyDefinition: keyed,
    TSAbstractMethodDefinition: keyed,
    TSAbstractPropertyDefinition: keyed,
    TSQualifiedName(node) {
      if (depth.inType === 0 && node.right.name === SERVICE) {
        hold(node);
      }
    },
    TemplateElement(node) {
      if (depth.inType === 0 && node.value.cooked === SERVICE_KEY) {
        hold(node);
      }
    },
    VariableDeclarator(node) {
      skip(node.id);
    },
    YieldExpression(node) {
      if (!node.delegate || node.argument === null) {
        return;
      }

      const target = unwrapped(node.argument);

      if (target.type === "Identifier") {
        skip(target);
      } else if (target.type === "MemberExpression") {
        reading.add(spanOf(target));
      }
    },
  };

  new Visitor({ ...typeVisitor, ...visitor }).visit(program);

  return found;
};
