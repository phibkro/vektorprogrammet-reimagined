/**
 * Every place of a source text that holds the domain's `InTransaction` as a value (spec 0018, falsifier 6, guarantee
 * TX5). The proof is an ordinary value, so nothing in the types stops a program from providing it; a reference is the
 * thing that a forgery cannot do without, whatever it is wrapped in or handed to. The scan therefore does not list the
 * ways to provide (`provideService`, `Layer.succeed`, `provideServiceEffect`, ...): it flags every reference to the
 * service as a value, except the ones that only read it.
 *
 * A reference is an identifier that names the service (`InTransaction`, or the local name that an import or a
 * destructuring gives it), a member access or a destructured key that names it (`Domain.InTransaction`,
 * `Domain["InTransaction"]`, `{ InTransaction: Proof } = Domain`), and an export of it under another name. Wrappers
 * cannot hide it, because the scan looks at the identifier and not at the expression around it: `(InTransaction)`,
 * `InTransaction as typeof InTransaction`, `InTransaction satisfies ...`, `InTransaction!`, `<T>InTransaction`,
 * `{ proof: InTransaction }`, `[InTransaction]`, `cond ? InTransaction : other`, a spread, a default export.
 *
 * Not references: `yield* InTransaction` (a program that requires the proof reads it), a type position (an
 * annotation, a type argument, `typeof InTransaction` in a type, `implements`, `extends`), the import and export
 * declarations themselves (an export under the same name, a type-only import), a declaration that happens to be named
 * the same, and a property key such as `{ InTransaction: "..." }`.
 *
 * What it does not see (a reviewer reads these): a name that is built at run time (`Domain[name]`,
 * `Object.values(Domain)`, `Reflect.get`), a whole namespace handed on and read elsewhere under a runtime key, and a
 * `Context` captured inside a transaction and provided after it has ended (that is the real proof, used late; it needs
 * no reference to the service).
 */
import { Array as Arr, Predicate, Record as Rec } from "effect";
import { Visitor, parseSync, visitorKeys } from "oxc-parser";
import type {
  Expression,
  ModuleExportName,
  PropertyKey,
  VisitorObject,
} from "oxc-parser";

const SERVICE = "InTransaction";

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
 * The lines of `text` that hold the service as a value. `path` names the language for the parser. A file that never
 * writes the word cannot hold the name (an aliased import still writes it), so it is not parsed: the scan reads every
 * file of three directories, and a two-CPU runner took more than five seconds to parse them all.
 */
export const proofReferences = (
  path: string,
  text: string
): readonly number[] => {
  if (!text.includes(SERVICE)) {
    return [];
  }

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
