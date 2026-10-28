/**
 * Runs a command inside a database transaction and provides `InTransaction` to it, so a command that requires it is
 * the one thing `run` takes off a program's requirements. The Layer that provides it lives with the store adapter
 * (`packages/db`'s `transactional`); tests provide their own over in-memory repositories (spec 0017: this port was
 * declared in the web app before).
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { InTransaction } from "./transaction.ts";

export class Transactor extends Context.Service<
  Transactor,
  {
    readonly run: <A, E, R>(
      program: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, Exclude<R, InTransaction>>;
  }
>()("@vektorprogrammet/domain/shared/Transactor") {}
