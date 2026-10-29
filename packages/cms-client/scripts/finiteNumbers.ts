import { String as Str } from "effect";
import { parseSync, Visitor } from "oxc-parser";

/** JSON numbers are finite; preserve the generator's checks and annotations. */
export const finiteNumbers = (source: string): string => {
  const { program } = parseSync("generated.ts", source);
  const positions: number[] = [];
  new Visitor({
    MemberExpression(node) {
      if (
        !node.computed &&
        node.object.type === "Identifier" &&
        node.object.name === "Schema" &&
        node.property.type === "Identifier" &&
        node.property.name === "Number"
      ) {
        positions.push(node.property.start);
      }
    },
  }).visit(program);
  let result = source;

  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const start = positions[index];

    if (start !== undefined) {
      result = `${Str.slice(0, start)(result)}Finite${Str.slice(start + 6)(result)}`;
    }
  }

  return result;
};
