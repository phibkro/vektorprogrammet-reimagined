/**
 * Single-use code storage: a conditional consume and a replace per purpose and subject. A code belongs to its subject
 * (spec 0006b): a write takes the subject's `Locked` token, and the subject is the token's person.
 */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { Locked } from "../shared/aggregate.ts";
import type { Code, CodeHash, CodePurpose } from "./code.ts";

export class CodeRepository extends Context.Service<
  CodeRepository,
  {
    /** Read a usable code without consuming it; this does not authorize the subsequent write. */
    readonly findUsable: (request: {
      readonly hash: CodeHash;
      readonly purpose: CodePurpose;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<Option.Option<Code>>;
    /** Invalidate the older code for the same purpose and the locked person, then store only this hash. */
    readonly replace: (
      locked: Locked<"Person">,
      code: Pick<Code, "expiresAt" | "hash" | "purpose">
    ) => Effect.Effect<void>;
    /** One conditional update; a missing, expired, used, wrong-purpose or wrong-subject code loses. */
    readonly consume: (
      locked: Locked<"Person">,
      request: {
        readonly hash: CodeHash;
        readonly purpose: CodePurpose;
        readonly now: DateTime.Utc;
      }
    ) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/domain/accounts/CodeRepository") {}
