/**
 * Runs a command inside a database transaction and provides `InTransaction` to it, so a command that requires it is
 * the one thing `run` takes off a program's requirements. The Layer that provides it lives with the store adapter
 * (`packages/db`'s `transactional`); tests provide their own over in-memory repositories (spec 0017: this port was
 * declared in the web app before).
 * `run` also refuses a program that requires an integration port (`IntegrationPort`, ADR 0015 rule 1, spec 0020): a
 * call to another system does not belong inside the transaction. The refusal is a bound on `R`, an early warning that
 * reads requirements and nothing else. It does not see a port that the program reaches without requiring it: a provider
 * built inside (`Effect.provide`), a port that a Layer captured when it was built, `Effect.serviceOption`,
 * `Effect.context` with `Context.getOption`, and a service that is not marked whose Layer captures a port. A generic
 * caller whose bound is `object` or `{}` admits every service, ports too. What the bound does not see, the runtime
 * guard refuses (spec 0024): every integration port is built through `refusingInTransaction` (`integrationGuard.ts`),
 * and a call made while the fiber holds the transaction's proof dies as `IntegrationCalledInTransaction`.
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
