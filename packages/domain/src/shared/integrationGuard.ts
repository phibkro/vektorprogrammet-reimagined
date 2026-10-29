/**
 * The runtime guard of ADR 0015 rule 1, no integration call inside a transaction (spec 0024). The type bound of
 * `Transactor.run` (`NotAnIntegration`, `transaction.ts`) reads a program's requirements and nothing else; this is the
 * check that sees what runs. An integration port's Layer builds its service through `refusingInTransaction`, and a call
 * made while the calling fiber holds the proof of an open transaction dies before the provider is reached.
 */
import { Effect, Option, Record as Rec, Schema } from "effect";
import { cast } from "effect/Function";

import { InTransaction } from "./transaction.ts";

/**
 * An integration port was called while a transaction was open on the fiber that called it. It is a defect, not an error
 * that a caller handles: the program was written wrong, and the first run that reaches the call finds it, with no
 * provider involved and nothing sent. `call` is the port and method, never an argument.
 */
export class IntegrationCalledInTransaction extends Schema.TaggedError<
  IntegrationCalledInTransaction,
  { readonly brand: unique symbol }
>()("IntegrationCalledInTransaction", {
  call: Schema.String,
}) {}

/**
 * `run`, unless the fiber holds the proof of an open transaction, in which case nothing runs and the call dies as
 * `IntegrationCalledInTransaction`. The proof is read from the fiber's context, where `Transactor.run` puts it for
 * everything below it: a child fiber of the transaction holds it too, and a call from a Layer that captured the port
 * is checked at the call, because the guard runs in the caller's fiber. A proof that has outlived its transaction still
 * refuses (a caller is not outside a transaction by having a stale proof).
 */
const outsideTransaction = <A, E, R>(
  call: string,
  run: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(InTransaction),
    Option.match({
      onNone: run,
      onSome: () => Effect.die(new IntegrationCalledInTransaction({ call })),
    })
  );

/** A method of a port (any arguments, an effect out). `never` arguments accept every method's own parameters. */
type Method = (...args: never[]) => Effect.Effect<unknown, unknown, unknown>;

/** What a member of an integration port is: a method, or an effect (a read with no arguments). */
type Member = Method | Effect.Effect<unknown, unknown, unknown>;

/** `member` behind the guard: a method refuses before it is called, an effect before it runs. */
const refusing = (call: string, member: Member) =>
  Effect.isEffect(member)
    ? outsideTransaction(call, () => member)
    : (...args: never[]) => outsideTransaction(call, () => member(...args));

/**
 * `service`, an implementation of the integration port `port`, with every member behind the guard. A service whose
 * members are not all methods or effects does not type-check, so a port cannot hold a member that the guard would
 * skip. Every Layer that provides an `IntegrationPort` builds its service through it (`MessageSender`,
 * `TurnstileVerifier`, `Auth`, `WorkspaceDirectory`, `WorkspaceWriter`), and a test calls each member of each shipped
 * Layer inside `Transactor.run` and expects the defect.
 */
export const refusingInTransaction = <
  Service extends { readonly [Name in keyof Service]: Member },
>(
  port: string,
  service: Service
): Service => {
  // SAFETY: the bound on `Service` says that every member is a `Member` (EX-0025).
  const members = cast<Service, Readonly<Record<string, Member>>>(service);

  const guarded = Rec.map(members, (member, key) =>
    refusing(`${port}.${key}`, member)
  );

  // SAFETY: each member is the member it was behind the guard, so the object has the type of `service` (EX-0025).
  return cast<typeof guarded, Service>(guarded);
};
