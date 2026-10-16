import { defineRule } from "vite-plus/lint/plugins";
import type {
  ESTree,
  Scope,
  SourceCode,
  Variable,
} from "vite-plus/lint/plugins";

import { resolveVariable } from "../shared/scope.ts";

type Callback = ESTree.ArrowFunctionExpression | ESTree.Function;

function within(inner: ESTree.Node, outer: ESTree.Node): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** The name of a Foldkit builder call `h.<name>(...)`, if the node is one. */
function builderMethod(node: ESTree.Node): string | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (callee.object.type !== "Identifier" || callee.object.name !== "h")
    return null;
  return callee.property.type === "Identifier" ? callee.property.name : null;
}

function isFunction(node: ESTree.Node | null | undefined): node is Callback {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function returnsOf(statement: ESTree.Statement): Array<ESTree.Expression> {
  switch (statement.type) {
    case "ReturnStatement":
      return statement.argument === null ? [] : [statement.argument];
    case "BlockStatement":
      return statement.body.flatMap(returnsOf);
    case "IfStatement":
      return [
        ...returnsOf(statement.consequent),
        ...(statement.alternate === null ? [] : returnsOf(statement.alternate)),
      ];
    default:
      return [];
  }
}

/** What a function returns: its expression body, or the arguments of its return statements. */
function returnedExpressions(fn: Callback): Array<ESTree.Node> {
  if (fn.body === null || fn.body === undefined) return [];
  return fn.body.type === "BlockStatement" ? returnsOf(fn.body) : [fn.body];
}

/** The expressions that a returned expression evaluates to, through conditionals and wrappers. */
function outcomes(node: ESTree.Node): Array<ESTree.Node> {
  switch (node.type) {
    case "ConditionalExpression":
      return [...outcomes(node.consequent), ...outcomes(node.alternate)];
    case "LogicalExpression":
      return outcomes(node.right);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return outcomes(node.expression);
    default:
      return [node];
  }
}

/** An element call `h.li(...)`; `h.keyed("li")(key, ...)` is keyed by construction and is not one. */
function isElementCall(node: ESTree.Node): node is ESTree.CallExpression {
  const method = builderMethod(node);
  return method !== null && /^[a-z]/u.test(method) && method !== "submodel";
}

function hasKey(element: ESTree.CallExpression): boolean {
  const attributes = element.arguments[0];
  return (
    attributes?.type === "ArrayExpression" &&
    attributes.elements.some(
      (attribute) => attribute !== null && builderMethod(attribute) === "Key"
    )
  );
}

/** The variables of a function scope and of its blocks, without nested functions and classes. */
function functionVariables(scope: Scope): Array<Variable> {
  return [
    ...scope.variables,
    ...scope.childScopes
      .filter((child) => child.type !== "function" && child.type !== "class")
      .flatMap(functionVariables),
  ];
}

function reads(variables: Iterable<Variable>, node: ESTree.Node): boolean {
  for (const variable of variables) {
    if (variable.references.some(({ identifier }) => within(identifier, node)))
      return true;
  }
  return false;
}

/**
 * The bindings of a function that hold the entry: the parameters that receive it, and the
 * locals whose initializers read one of those bindings.
 */
function entryBindings(
  sourceCode: SourceCode,
  fn: Callback,
  entryParameters: ReadonlyArray<ESTree.Node>
): Set<Variable> {
  const variables = functionVariables(sourceCode.getScope(fn));
  const entry = new Set(
    variables.filter((variable) =>
      variable.defs.some(
        (definition) =>
          definition.type === "Parameter" &&
          entryParameters.some((parameter) =>
            within(definition.name, parameter)
          )
      )
    )
  );
  for (const variable of variables) {
    const declarator = variable.defs.find(
      (definition) => definition.type === "Variable"
    )?.node;
    const init =
      declarator?.type === "VariableDeclarator" ? declarator.init : null;
    if (
      !entry.has(variable) &&
      init !== null &&
      init !== undefined &&
      reads(entry, init)
    ) {
      entry.add(variable);
    }
  }
  return entry;
}

/**
 * Whether the identifier is read inside the object argument of a message constructor call,
 * `Message({ ... })`, below the element.
 */
function readInMessage(identifier: ESTree.Node, element: ESTree.Node): boolean {
  let child: ESTree.Node = identifier;
  let parent = identifier.parent;
  while (parent !== null && parent !== undefined && child !== element) {
    if (
      parent.type === "CallExpression" &&
      parent.callee.type === "Identifier" &&
      /^[A-Z]/u.test(parent.callee.name) &&
      child.type === "ObjectExpression" &&
      parent.arguments.some((argument) => argument === child)
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function bindsEntry(
  entry: Set<Variable>,
  element: ESTree.CallExpression
): boolean {
  for (const variable of entry) {
    if (
      variable.references.some(
        ({ identifier }) =>
          within(identifier, element) && readInMessage(identifier, element)
      )
    ) {
      return true;
    }
  }
  return false;
}

/** The function that a same-file helper name binds, if any. */
function helperFunction(
  sourceCode: SourceCode,
  callee: ESTree.Node
): Callback | null {
  if (callee.type !== "Identifier") return null;
  const definition = resolveVariable(sourceCode, callee)?.defs[0];
  if (definition === undefined) return null;
  if (definition.type === "FunctionName" && isFunction(definition.node))
    return definition.node;
  if (
    definition.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
  ) {
    return isFunction(definition.node.init) ? definition.node.init : null;
  }
  return null;
}

/**
 * Require a key on the Foldkit element that renders one entry of a collection when that element
 * dispatches a message built from the entry: the element that a `.map` callback returns, or that
 * a same-file helper returns when the callback passes it the entry. Snabbdom patches unkeyed
 * siblings by position: when a reload reorders the collection, a control that a user focuses or
 * a browser driver has resolved stays in place and dispatches the message of the entry that moved
 * into its row. In hosted run 36240534206 the "Publiser" control of one article published another.
 */
export const noUnkeyedCommandRowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require h.Key on a per-entry Foldkit element whose controls dispatch messages built from the entry.",
    },
    messages: {
      unkeyedCommandRow:
        "This element renders one entry and dispatches messages built from it, but it has no h.Key. A reorder patches unkeyed rows by position and moves the entry's commands onto another entry. Key it by the identity that its messages name.",
    },
  },
  createOnce(context) {
    // A helper that several maps call is reported once per file.
    let reported = new Set<ESTree.Node>();

    const checkElements = (fn: Callback, entry: Set<Variable>) => {
      for (const element of returnedExpressions(fn).flatMap(outcomes)) {
        if (
          isElementCall(element) &&
          !reported.has(element) &&
          !hasKey(element) &&
          bindsEntry(entry, element)
        ) {
          reported.add(element);
          context.report({ node: element, messageId: "unkeyedCommandRow" });
        }
      }
    };

    return {
      before() {
        reported = new Set();
      },
      CallExpression(node) {
        const callee = node.callee;
        const callback = node.arguments[0];
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "map" ||
          !isFunction(callback)
        ) {
          return;
        }

        const { sourceCode } = context;
        const entry = entryBindings(sourceCode, callback, callback.params);
        checkElements(callback, entry);

        // rows.map((row) => rowView(model, row, h)): the helper renders the entry's element.
        for (const returned of returnedExpressions(callback).flatMap(
          outcomes
        )) {
          if (returned.type !== "CallExpression") continue;
          const helper = helperFunction(sourceCode, returned.callee);
          if (helper === null) continue;
          const entryParameters = helper.params.filter((_, index) => {
            const argument = returned.arguments[index];
            return argument !== undefined && reads(entry, argument);
          });
          if (entryParameters.length === 0) continue;
          checkElements(
            helper,
            entryBindings(sourceCode, helper, entryParameters)
          );
        }
      },
    };
  },
});
