import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

function propertyName(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}

function memberName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression") return null;
  return propertyName(node.property);
}

function hasExplicitTimeZone(options: ESTree.Node | null | undefined): boolean {
  return (
    options?.type === "ObjectExpression" &&
    options.properties.some(
      (property) =>
        property.type === "Property" &&
        propertyName(property.key) === "timeZone" &&
        !(
          property.value.type === "Identifier" &&
          property.value.name === "undefined"
        )
    )
  );
}

function isIntlDateTimeFormat(callee: ESTree.Node): boolean {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Intl" &&
    memberName(callee) === "DateTimeFormat"
  );
}

function isDateLocaleCall(callee: ESTree.Node): boolean {
  if (callee.type !== "MemberExpression") return false;
  const name = memberName(callee);
  if (name === "toLocaleDateString" || name === "toLocaleTimeString")
    return true;
  // Number.toLocaleString is not a date formatter and has no timeZone option.
  return (
    name === "toLocaleString" &&
    callee.object.type === "NewExpression" &&
    callee.object.callee.type === "Identifier" &&
    callee.object.callee.name === "Date"
  );
}

/** A calendar label must not vary with the SSR host or the visitor's machine time zone. */
export const noImplicitDateTimeZoneRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an explicit timeZone when rendering a date or time in browser applications.",
    },
    messages: {
      implicitDateTimeZone:
        "Name the calendar timeZone (for example, Europe/Oslo) in the formatter options so SSR and browser render the same date.",
    },
  },
  createOnce(context) {
    return {
      NewExpression(node) {
        if (
          isIntlDateTimeFormat(node.callee) &&
          !hasExplicitTimeZone(node.arguments[1])
        ) {
          context.report({ node, messageId: "implicitDateTimeZone" });
        }
      },
      CallExpression(node) {
        if (
          (isIntlDateTimeFormat(node.callee) ||
            isDateLocaleCall(node.callee)) &&
          !hasExplicitTimeZone(node.arguments[1])
        ) {
          context.report({ node, messageId: "implicitDateTimeZone" });
        }
      },
    };
  },
});
