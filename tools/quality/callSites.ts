import { Array as Arr } from "effect";
import { parseSync, Visitor } from "oxc-parser";

/**
 * Whether `text` (the file `path`) has a call written `inner(…)` inside the arguments of a call written `outer(…)`, as
 * the callees are spelled in the source (`transactor.run`, `sender.send`). `moduleGraph.ts` keys a tolerated integration
 * call to this, so a restructure that moves the call out of the transaction makes the entry stale, and a comment or a
 * method that only has the same name does not keep it alive.
 */
export const callsWithin = (
  path: string,
  text: string,
  outer: string,
  inner: string
): boolean => {
  const { program } = parseSync(path, text);
  const outers: (readonly [number, number])[] = [];
  const inners: number[] = [];

  new Visitor({
    CallExpression(node) {
      // The callee as written, however the source breaks the line (`transactor\n  .run`).
      const callee = text
        .slice(node.callee.start, node.callee.end)
        .replaceAll(/\s+/gu, "");

      if (callee === outer) {
        outers.push([node.start, node.end]);
      }

      if (callee === inner) {
        inners.push(node.start);
      }
    },
  }).visit(program);

  return Arr.some(outers, ([start, end]) =>
    Arr.some(inners, (at) => at > start && at < end)
  );
};
