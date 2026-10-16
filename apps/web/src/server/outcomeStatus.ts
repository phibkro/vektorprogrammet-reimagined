/**
 * A server function answers with an `Outcome`: the browser decodes the body, typed failures included.
 * This middleware also sends the failure's status (chosen once, by the table in `errors.ts`) as the HTTP
 * status of the reply, so a refused request is a real 403 on the wire, not a 200 that carries one. The
 * client decodes serialized replies whatever their status, so no caller changes.
 */
import { createMiddleware } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { Predicate, Schema } from "effect";

const isFailureOutcome = Schema.is(
  Schema.TaggedStruct("Failure", { status: Schema.Int })
);

export const outcomeStatusMiddleware = createMiddleware({
  type: "function",
}).server(({ next }) =>
  next().then((reply) => {
    // The framework types the reply without its `result`, but the handler's return value travels in it.
    if (
      Predicate.hasProperty(reply, "result") &&
      isFailureOutcome(reply.result)
    ) {
      setResponseStatus(reply.result.status);
    }

    return reply;
  })
);
