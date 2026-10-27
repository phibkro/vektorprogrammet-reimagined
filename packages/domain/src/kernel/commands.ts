/**
 * Commands (ADR 0006): each is an `Rpc.make(name, { payload, success, error })` in one `RpcGroup` per domain. This
 * module holds what the kernel adds around `effect/rpc`:
 *
 * - `Info`, the annotation every command carries: its summary in plain words, the resource it acts on and the method
 *   it uses (ADR 0010), the legacy rules it replaces, the job that alone runs it (if it is a job's), and the machine
 *   whose transition it applies. The grants, the completeness tests and the generated docs read it.
 * - `inProcess`, the client a server function (or a scheduled job) calls: the group’s handlers connected
 *   in memory, so there is no HTTP surface beside TanStack Start’s.
 * - `decodePayload`, the decoder of a command's payload schema: the form and the handler use the same schema.
 */
import { Array as Arr, Context, Effect } from "effect";
import type { Layer, Option } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import type { Rpc, RpcGroup } from "effect/rpc";

import type { CodePurpose } from "../accounts/code.ts";
import { EntityName } from "../shared/ids.ts";
import { decodeInput } from "../shared/validation.ts";
import type { SystemJob } from "./principal.ts";

/**
 * The nouns that commands act on and that no error or audit row names, so they are not in `EntityName`. Adding one
 * to `EntityName` would widen the `CHECK` on `audit_log.entity` (a migration) for a value that no row can hold.
 */
export const NonEntityResources = [
  "AuditEntry",
  "OutboxMessage",
  "SupportTicket",
  "WorkspaceReport",
] as const;

/**
 * What a command acts on (ADR 0010, AIP-121): an entity that the domain names, or one of `NonEntityResources`. The set
 * is closed, so a typo cannot become a second noun: a new noun is added here or to `EntityName` first.
 */
export type Resource = EntityName | (typeof NonEntityResources)[number];

/** Every resource, in the order that the generated reference lists them: the entities, then the other nouns. */
export const Resources: readonly Resource[] = [
  ...EntityName.literals,
  ...NonEntityResources,
];

/** The standard methods (AIP-131 to AIP-135), in the order that the generated reference lists them. */
export const StandardMethods = [
  "get",
  "list",
  "create",
  "update",
  "delete",
] as const;

export type StandardMethod = (typeof StandardMethods)[number];

/**
 * A custom method (AIP-136), written as ADR 0010 writes it in a URL: a colon, then a lowerCamelCase verb (`":extend"`).
 * The completeness test refuses a verb of another shape.
 */
export type CustomMethod = `:${string}`;

/**
 * How a command acts on its resource (ADR 0010). A standard method is the default; a custom method is the fallback for
 * an intent that a standard one would blur. Nothing here can promise a `412`: that needs a row version, and none
 * exists (a promise is added to `update` together with the column).
 */
export type Method = StandardMethod | CustomMethod;

/** Whether `method` is a standard one. */
export const isStandard = (method: Method): method is StandardMethod =>
  Arr.contains(StandardMethods, method);

/** The verb that a command's name starts with: a standard method itself, or a custom verb without its colon. */
export const verbOf = (method: Method): string =>
  isStandard(method) ? method : method.slice(1);

/** A query changes nothing; a command may. `get` and `list` are queries and every other method is a command. */
export type Kind = "command" | "query";

export const kindOf = (method: Method): Kind =>
  method === "get" || method === "list" ? "query" : "command";

export interface CommandInfo {
  /** What the command does, in one plain English sentence: the line a "who does what" table shows. */
  readonly summary: string;
  /** What the command acts on (ADR 0010). */
  readonly resource: Resource;
  /** How it acts on it (ADR 0010): a standard method, or a custom verb that a standard one would blur. */
  readonly method: Method;
  /** The legacy rules (`RULE-206`, …) that this command replaces or whose behaviour it keeps. */
  readonly replaces: readonly string[];
  /** The scheduled job that alone runs this command; no person holds it, not even an admin (R1). */
  readonly job: SystemJob | null;
  /** A single-use code purpose that alone grants this command. */
  readonly credential: CodePurpose | null;
  /** The machine whose transitions this command applies. */
  readonly machine: string | null;
  /** A condition that the grant table cannot state, shown beside the command in the generated reference. */
  readonly note: string | null;
}

/** The annotation of a command (`Rpc.annotate(Info, info({ … }))`). */
export class Info extends Context.Service<Info, CommandInfo>()(
  "@vektorprogrammet/domain/kernel/Command"
) {}

/** The value of the `Info` annotation. `summary`, `resource` and `method` are required. */
export const info = (fields: {
  readonly summary: string;
  readonly resource: Resource;
  readonly method: Method;
  readonly replaces?: readonly string[];
  readonly job?: SystemJob;
  readonly credential?: CodePurpose;
  readonly machine?: string;
  readonly note?: string;
}): CommandInfo => ({
  credential: fields.credential ?? null,
  job: fields.job ?? null,
  machine: fields.machine ?? null,
  method: fields.method,
  note: fields.note ?? null,
  replaces: fields.replaces ?? [],
  resource: fields.resource,
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
      // Effect 4.0.6 RpcTest.makeClient uses the same no-serialization wiring.
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
