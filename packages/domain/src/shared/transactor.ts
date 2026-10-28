/**
 * Runs a command inside a database transaction and provides `InTransaction` to it, so a command that requires it is
 * the one thing `run` takes off a program's requirements. The Layer that provides it lives with the store adapter
 * (`packages/db`'s `transactional`); tests provide their own over in-memory repositories (spec 0017: this port was
 * declared in the web app before).
 *
 * `run` also refuses a program that requires an integration port (`IntegrationPort`, ADR 0015 rule 1, spec 0020): a
 * call to another system does not belong inside the transaction. The refusal is a bound on `R`, so it holds for a
 * program that requires the port itself, and not for one that builds the provider inside (`Effect.provide`): the type
 * sees requirements, not what a program does with a Layer it makes.
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { InTransaction, NotAnIntegration } from "./transaction.ts";

export class Transactor extends Context.Service<
  Transactor,
  {
    readonly run: <A, E, R extends NotAnIntegration>(
      program: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, Exclude<R, InTransaction>>;
  }
>()("@vektorprogrammet/domain/shared/Transactor") {}
