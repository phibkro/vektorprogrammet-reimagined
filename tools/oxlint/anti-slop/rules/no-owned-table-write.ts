import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree, SourceCode } from "vite-plus/lint/plugins";

import { Ownership } from "../../../../packages/db/src/aggregate/ownership.ts";
import { resolveVariable } from "../shared/scope.ts";

/** The statements that write a table. */
const WRITES: Readonly<Record<string, true>> = {
  delete: true,
  insert: true,
  update: true,
};

/** The schema module of `packages/db`: `../schema.ts`, `./schema.ts`, `@vektorprogrammet/db/schema`. */
const SCHEMA_MODULE = /(?:^|\/)schema(?:\.[cm]?[jt]s)?$/u;

interface Declared {
  /** An owned table is written under its owner's lock; a root's own table is written under its own lock. */
  readonly kind: "owned" | "root";
  readonly root: string;
  /** The column that a stored machine owns, when the table has one. */
  readonly state: string | undefined;
}

/** Every table that the ownership declaration names, by the name that `schema.ts` exports it under. */
const declared = new Map<string, Declared>();

for (const root of Ownership) {
  declared.set(root.table, { kind: "root", root: root.name, state: undefined });

  for (const [name, owned] of Object.entries<{ state?: string }>(root.owns)) {
    declared.set(name, { kind: "owned", root: root.name, state: owned.state });
  }
}

function importedName(node: ESTree.ImportSpecifier): string {
  return node.imported.type === "Identifier"
    ? node.imported.name
    : String(node.imported.value);
}

/** Where an identifier was imported from, and by which specifier; `null` for anything that is not an import. */
function importOf(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference
) {
  const variable = resolveVariable(sourceCode, identifier);

  for (const definition of variable?.defs ?? []) {
    if (
      definition.type === "ImportBinding" &&
      definition.parent?.type === "ImportDeclaration"
    ) {
      return {
        source: String(definition.parent.source.value),
        specifier: definition.node,
      };
    }
  }

  return null;
}

/**
 * The name of the schema table that an expression stands for, when it is one: a table imported by name from the schema
 * module (`membership`), or a property of the schema namespace (`schema.membership`, from `import * as schema` or
 * `import { schema } from "@vektorprogrammet/db"`).
 */
function schemaTableName(
  sourceCode: SourceCode,
  node: ESTree.Node | undefined
): string | null {
  if (node?.type === "Identifier") {
    const found = importOf(sourceCode, node);

    return found !== null &&
      found.specifier.type === "ImportSpecifier" &&
      SCHEMA_MODULE.test(found.source)
      ? importedName(found.specifier)
      : null;
  }

  if (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.property.type === "Identifier"
  ) {
    const found = importOf(sourceCode, node.object);

    if (found === null) {
      return null;
    }

    const namespace =
      (found.specifier.type === "ImportNamespaceSpecifier" &&
        SCHEMA_MODULE.test(found.source)) ||
      (found.specifier.type === "ImportSpecifier" &&
        importedName(found.specifier) === "schema");

    return namespace ? node.property.name : null;
  }

  return null;
}

function keyName(key: ESTree.Node): string | null {
  if (key.type === "Identifier") return key.name;
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : null;
}

/** `update(T).set({ state: … })`: the statement that this call starts sets the state column. */
function setsState(call: ESTree.CallExpression, state: string): boolean {
  const member = call.parent;

  if (
    member?.type !== "MemberExpression" ||
    member.object !== call ||
    member.computed ||
    member.property.type !== "Identifier" ||
    member.property.name !== "set"
  ) {
    return false;
  }

  const setting = member.parent;

  if (setting?.type !== "CallExpression" || setting.callee !== member) {
    return false;
  }

  const [values] = setting.arguments;

  return (
    values?.type === "ObjectExpression" &&
    values.properties.some(
      (property) =>
        property.type === "Property" && keyName(property.key) === state
    )
  );
}

/**
 * Ban Drizzle writes to a table that an aggregate root owns, outside the aggregate writer (`Aggregates`). An owned
 * table is written only with the lock of its owner (`Locked<Root>`), and a stored machine's state column only by
 * `Aggregates.apply`. A root's own table is created freely (no token exists before the row does) and updated or
 * deleted only under its lock. The declaration is `packages/db/src/aggregate/ownership.ts`, the one that the lock
 * construct and the closure test read.
 */
export const noOwnedTableWriteRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Drizzle insert, update and delete of a table that an aggregate root owns, outside the aggregate writer: a write takes the owner's lock token, and a machine's state is written only by `apply`.",
    },
    messages: {
      ownedTableWrite:
        "`{{table}}` is owned by {{root}}: a write to it takes the owner's lock. Write it with `Aggregates.insert`, `update` or `remove` and the `Locked<{{root}}>` token (spec 0006b), not with Drizzle's `{{verb}}`.",
      rootTableWrite:
        "`{{table}}` is the row that {{root}}'s lock is taken on. Change or delete it with `Aggregates.updateRoot` and the `Locked<{{root}}>` token (spec 0006b); only creating a row takes no token.",
      stateColumnWrite:
        "`{{table}}.{{column}}` is the state of a stored machine. Only `Aggregates.apply` writes it, with a transition of the machine: `UPDATE … SET state = to WHERE owner = $1 AND state = ANY(from)` (spec 0006b). A direct write loses an update silently.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;

        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !Object.hasOwn(WRITES, callee.property.name)
        ) {
          return;
        }

        const verb = callee.property.name;
        const table = schemaTableName(context.sourceCode, node.arguments[0]);
        const found = table === null ? undefined : declared.get(table);

        if (table === null || found === undefined) {
          return;
        }

        if (found.kind === "root") {
          if (verb !== "insert") {
            context.report({
              data: { root: found.root, table },
              messageId: "rootTableWrite",
              node,
            });
          }

          return;
        }

        if (
          verb === "update" &&
          found.state !== undefined &&
          setsState(node, found.state)
        ) {
          context.report({
            data: { column: found.state, table },
            messageId: "stateColumnWrite",
            node,
          });

          return;
        }

        context.report({
          data: { root: found.root, table, verb },
          messageId: "ownedTableWrite",
          node,
        });
      },
    };
  },
});
