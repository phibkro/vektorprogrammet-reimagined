/**
 * Authorization from the kernel's grant table, in the two places an `@alchemy.run/domain` command can be judged:
 *
 * 1. `GrantGuard`, the command middleware (`Command.middleware`). It runs when a client sends the command through
 *    an `Api`, before the command reaches its aggregate: it uses the authenticated request principal, resolves what the
 *    command is about (`facts.ts`), asks `authorize` (the one function over `GrantTable`), refuses with the kernel's
 *    `Forbidden`, and otherwise provides the principal and the facts to what runs next. A principal without a grant
 *    never reaches `decide`.
 * 2. `requireGrant`, the first line of every `decide`. A command that is not sent through an `Api` (a policy, a job,
 *    a test, the facade) provides the same two context services itself, and `decide` asks the same function. The
 *    middleware is the early refusal, this is the check that nothing sent past it can skip.
 *
 * There is no role list and no second table here: both ask `authorize` (`@vektorprogrammet/domain`), whose data is
 * the grant rows of each domain's declaration. Deleting a row changes the answer of both.
 */
import {
  CurrentPrincipal,
  Forbidden as DomainForbidden,
  NotFound as DomainNotFound,
  authorize,
} from "@vektorprogrammet/domain";
import type { Command, Principal } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";

import { CommandFacts, RequestPrincipal } from "./context.ts";
import type { Facts } from "./context.ts";
import { CommandPayloadSchema, factsOf, isHostedCommand } from "./facts.ts";
import type { CommandPayload, HostedCommand } from "./facts.ts";
import { Forbidden } from "./rejections.ts";

/** Whether the grant table lets `principal` run `command` about every resource of `facts`. */
export const allows = (
  principal: Principal,
  command: Command,
  facts: Facts
): boolean =>
  Arr.isReadonlyArrayEmpty(facts.resources)
    ? authorize(principal, command)
    : Arr.every(facts.resources, (resource) =>
        authorize(principal, command, resource)
      );

/** The first line of a `decide`: refuse with `Forbidden` unless the grant table allows the command. */
export const requireGrant = Effect.fnUntraced(function* requireGrant(
  command: Command
) {
  const principal = yield* RequestPrincipal;
  const facts = yield* CommandFacts;

  if (!allows(principal, command, facts)) {
    return yield* new Forbidden({ command });
  }

  return yield* Effect.void;
});

/**
 * The early refusal: resolves what `command` is about and asks the grant table, before anything is sent. The command
 * middleware and the facade call exactly this, so a command is judged by one function whichever way it is sent.
 */
export const admit = Effect.fnUntraced(function* admit(
  principal: Principal,
  command: HostedCommand,
  payload: CommandPayload
) {
  const facts = yield* factsOf(command, payload);

  if (!allows(principal, command, facts)) {
    return yield* new DomainForbidden({ command });
  }

  return facts;
});

/** The command middleware: provides the principal and the facts of the command, or refuses. */
export class GrantGuard extends RpcMiddleware.Service<
  GrantGuard,
  {
    provides: RequestPrincipal | CommandFacts;
    requires: CurrentPrincipal;
  }
>()("vektorprogrammet/spike/GrantGuard", {
  error: Schema.Union([DomainForbidden, DomainNotFound]),
}) {}

/**
 * The implementation of `GrantGuard`, for a server that hosts an `Api`. `Command` tags are the kernel's command names,
 * so `rpc._tag` is the name that the grant table is keyed by.
 */
export const GrantGuardLive = Layer.effect(
  GrantGuard,
  Effect.gen(function* grantGuardLive() {
    const sql = yield* SqlClient;

    return GrantGuard.of((effect, { payload, rpc }) =>
      Effect.gen(function* guard() {
        const principal = yield* CurrentPrincipal;
        const commandName = rpc._tag;

        if (!isHostedCommand(commandName)) {
          return yield* Effect.die(`unsupported command ${commandName}`);
        }

        const commandPayload = yield* Schema.decodeUnknownEffect(
          CommandPayloadSchema
        )(payload).pipe(Effect.orDie);

        const facts = yield* admit(principal, commandName, commandPayload);

        return yield* effect.pipe(
          Effect.provideService(RequestPrincipal, principal),
          Effect.provideService(CommandFacts, facts)
        );
      }).pipe(Effect.provideService(SqlClient, sql))
    );
  })
);
