/**
 * Commands (ADR 0006): each is an `Rpc.make(name, { payload, success, error })` in one `RpcGroup` per domain. This
 * module holds what the kernel adds around `effect/rpc`:
 *
 * - `Info`, the annotation every command carries: its summary in plain words, the legacy rules it replaces, the job
 *   that alone runs it (if it is a job's), and the machine whose transition it applies. The grants, the
 *   completeness tests and the generated docs read it.
 * - `inProcess`, the client a server function (or a scheduled job) calls: the group’s handlers connected
 *   in memory, so there is no HTTP surface beside TanStack Start’s.
 * - `decodePayload`, the decoder of a command's payload schema: the form and the handler use the same schema.
 */
import { Context, Effect } from "effect";
import type { Layer, Option } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import type { Rpc, RpcGroup } from "effect/rpc";

import { decodeInput } from "../shared/validation.ts";
import type { SystemJob } from "./principal.ts";

export interface CommandInfo {
  /** What the command does, in one plain English sentence: the line a "who does what" table shows. */
  readonly summary: string;
  /** The legacy rules (`RULE-206`, …) that this command replaces or whose behaviour it keeps. */
  readonly replaces: readonly string[];
  /** The scheduled job that alone runs this command; no person holds it, not even an admin (R1). */
  readonly job: SystemJob | null;
  /** The machine whose transitions this command applies. */
  readonly machine: string | null;
  /** A condition that the grant table cannot state, shown beside the command in the generated reference. */
  readonly note: string | null;
}

/** The annotation of a command (`Rpc.annotate(Info, info({ … }))`). */
export class Info extends Context.Service<Info, CommandInfo>()(
  "@vektorprogrammet/domain/kernel/Command"
) {}

/** The value of the `Info` annotation. Only `summary` is required. */
export const info = (fields: {
  readonly summary: string;
  readonly replaces?: readonly string[];
  readonly job?: SystemJob;
  readonly machine?: string;
  readonly note?: string;
}): CommandInfo => ({
  job: fields.job ?? null,
  machine: fields.machine ?? null,
  note: fields.note ?? null,
  replaces: fields.replaces ?? [],
  summary: fields.summary,
});

/** The `Info` annotation of a command, absent when the declaration forgot it (the completeness test fails then). */
export const infoOf = (rpc: Rpc.Any): Option.Option<CommandInfo> =>
  Context.getOption(rpc.annotations, Info);

interface RpcLink<Rpcs extends Rpc.Any> {
  client?: Effect.Success<
    ReturnType<typeof RpcClient.makeNoSerialization<Rpcs, never>>
  >;
}

/**
 * A client for `group` whose handlers run in this process: `inProcess(group, handlers)((client) => …)` builds the
 * handlers, connects a client to them in memory (no serialization, so typed errors arrive as the classes the
 * handlers failed with), runs `use` and tears both down. A server function builds this inside the transaction of
 * the command it runs; a defect or an interruption in the handler reaches `use` unchanged.
 */
export const inProcess =
  <Rpcs extends Rpc.Any, ProvideError, ProvideServices>(
    group: RpcGroup.RpcGroup<Rpcs>,
    handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, ProvideError, ProvideServices>
  ) =>
  <A, E, R>(
    use: (client: RpcClient.RpcClient<Rpcs>) => Effect.Effect<A, E, R>
  ) =>
    Effect.gen(function* inProcessClient() {
      // Effect 4.0.5 RpcTest.makeClient uses the same no-serialization wiring.
      const link: RpcLink<Rpcs> = {};

      const server = yield* RpcServer.makeNoSerialization(group, {
        onFromServer: (response) =>
          link.client === undefined
            ? Effect.die("RPC client not initialized")
            : link.client.write(response),
      });

      const client = yield* RpcClient.makeNoSerialization(group, {
        onFromClient: ({ message }) => server.write(0, message),
        supportsAck: true,
      });

      link.client = client;

      return client.client;
    }).pipe(Effect.flatMap(use), Effect.scoped, Effect.provide(handlers));

/** Decodes untrusted input with the payload schema of `rpc`; every issue becomes one `ValidationFailed`. */
export const decodePayload = <
  Payload extends Parameters<typeof decodeInput>[0],
>(rpc: {
  readonly payloadSchema: Payload;
}) => decodeInput(rpc.payloadSchema);

/**
 * A server function's entry for one command: untrusted input in, the command's own result out. It decodes the input
 * with the payload schema of the command (so the browser's form and the handler share one schema) and hands the
 * decoded payload to `send`, which calls the in-process client. A failed decode is a `ValidationFailed`.
 */
export const endpoint =
  <Payload extends Parameters<typeof decodeInput>[0], A, E, R>(
    rpc: { readonly payloadSchema: Payload },
    send: (payload: Payload["Type"]) => Effect.Effect<A, E, R>
  ) =>
  (input: unknown) =>
    Effect.flatMap(decodeInput(rpc.payloadSchema)(input), send);
