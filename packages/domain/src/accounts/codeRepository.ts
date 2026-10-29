/**
 * Code storage: one code per purpose and person, moved by the transitions of `CodeMachine` (spec 0024). A code belongs
 * to its subject (spec 0006b): a write takes the subject's `Locked` token, and the subject is the token's person. Only
 * a `Usable` code is ever read or spent: an `Unsent` code, stored by the transaction that minted it and not yet
 * acknowledged, is invisible to `findUsable` and refused by `consume`.
 */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { Locked } from "../shared/aggregate.ts";
import type { InTransaction } from "../shared/transaction.ts";
import type { Code, CodeHash, CodePurpose, codePolicy } from "./code.ts";

/** The purposes whose code one use ends (`codePolicy.singleUse`): `consume` takes no other, so a reusable code is never spent. */
export type SingleUsePurpose = {
  [
    Purpose in CodePurpose
  ]: (typeof codePolicy)[Purpose]["singleUse"] extends true ? Purpose : never;
}[CodePurpose];

export class CodeRepository extends Context.Service<
  CodeRepository,
  {
    /** Read a `Usable`, unexpired code without consuming it; this does not authorize the subsequent write. */
    readonly findUsable: (request: {
      readonly hash: CodeHash;
      readonly purpose: CodePurpose;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<Option.Option<Code>>;
    /**
     * Issue a code: the older code of this purpose and person goes, in whatever state it is in (RULE-220), and this
     * hash is stored `Unsent`. It authenticates nothing until `acknowledge` has moved it.
     */
    readonly issue: (
      locked: Locked<"Person">,
      code: Pick<Code, "expiresAt" | "hash" | "purpose">
    ) => Effect.Effect<void, never, InTransaction>;
    /**
     * `acknowledgeCode`: `Unsent → Usable` for the code with this hash, in one conditional update. `false` when that
     * code is not there (a newer code replaced it, or the person's rows were erased) or is not `Unsent`.
     */
    readonly acknowledge: (
      locked: Locked<"Person">,
      request: { readonly hash: CodeHash; readonly purpose: CodePurpose }
    ) => Effect.Effect<boolean, never, InTransaction>;
    /** `Usable → Used`, one conditional update; a missing, `Unsent`, used, expired, wrong-purpose or wrong-subject code loses. */
    readonly consume: (
      locked: Locked<"Person">,
      request: {
        readonly hash: CodeHash;
        readonly purpose: SingleUsePurpose;
        readonly now: DateTime.Utc;
      }
    ) => Effect.Effect<boolean, never, InTransaction>;
  }
>()("@vektorprogrammet/domain/accounts/CodeRepository") {}
