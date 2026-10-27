/** Single-use code storage: a conditional consume and a replace per purpose and subject. */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { PersonId } from "../shared/ids.ts";
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
    /** Invalidate the older code for the same purpose and subject, then store only this hash. */
    readonly replace: (code: Code) => Effect.Effect<void>;
    /** One conditional update; a missing, expired, used, wrong-purpose or wrong-subject code loses. */
    readonly consume: (request: {
      readonly hash: CodeHash;
      readonly purpose: CodePurpose;
      readonly subject: PersonId;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/domain/accounts/CodeRepository") {}
