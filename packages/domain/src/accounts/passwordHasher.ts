/** Password hashing is a boundary capability; the Worker supplies bcrypt. */
import { Context, Schema } from "effect";
import type { Effect } from "effect";

/** A complete bcrypt hash. Passwords are never persisted in an outbox row. */
export const PasswordHash = Schema.String.check(
  Schema.isPattern(
    /^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/u,
    {
      expected: "a bcrypt password hash",
    }
  )
).pipe(Schema.brand("PasswordHash"));

export type PasswordHash = typeof PasswordHash.Type;

export class PasswordHasher extends Context.Service<
  PasswordHasher,
  { readonly hash: (password: string) => Effect.Effect<PasswordHash> }
>()("@vektorprogrammet/domain/accounts/PasswordHasher") {}
