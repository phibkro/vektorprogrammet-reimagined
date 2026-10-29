import { Array as Arr, Option } from "effect";
import { parseSync, Visitor } from "oxc-parser";

import type { ServiceMethod } from "./moduleGraph.ts";

/** A call `receiver.method(…)` with the span of the call. */
interface MethodCall {
  readonly end: number;
  readonly method: string;
  readonly receiver: string;
  readonly start: number;
}

/**
 * Whether `text` (the file `path`) calls the method `inner` of one service inside the arguments of a call of the method
 * `outer` of another, with each receiver known by what the file binds it to (`const mailer = yield* MessageSender`),
 * and not by how it is spelled. `moduleGraph.ts` keys a tolerated integration call to this: a restructure that moves
 * the call out of the transaction makes the entry stale, and a comment, a method that only has the same name, or a
 * variable that is renamed does not change the answer.
 */
export const callsWithin = (
  path: string,
  text: string,
  outer: ServiceMethod,
  inner: ServiceMethod
): boolean => {
  const { program } = parseSync(path, text);
  const bindings = new Map<string, string>();
  const calls: MethodCall[] = [];

  new Visitor({
    CallExpression(node) {
      const { callee } = node;

      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier"
      ) {
        calls.push({
          end: node.end,
          method: callee.property.name,
          receiver: callee.object.name,
          start: node.start,
        });
      }
    },
    VariableDeclarator({ id, init }) {
      if (
        id.type === "Identifier" &&
        init?.type === "YieldExpression" &&
        init.delegate &&
        init.argument?.type === "Identifier"
      ) {
        bindings.set(id.name, init.argument.name);
      }
    },
  }).visit(program);

  const callsOf = ({ method, service }: ServiceMethod) =>
    Arr.filter(
      calls,
      (call) =>
        call.method === method &&
        Option.fromNullishOr(bindings.get(call.receiver)).pipe(
          Option.exists((bound) => bound === service)
        )
    );

  const inners = callsOf(inner);

  return Arr.some(callsOf(outer), (around) =>
    Arr.some(
      inners,
      (call) => call.start > around.start && call.end <= around.end
    )
  );
};
