/** A code opens a request-scoped, narrowed principal, never a Better Auth login session (spec 0007 R2). */
import { DateTime, Effect, Option } from "effect";

import { Principal } from "../kernel/principal.ts";
import { codePolicy, hashCode } from "./code.ts";
import type { CodePurpose, CodeToken } from "./code.ts";
import { CodeRepository } from "./codeRepository.ts";
import { AccountRepository } from "./services.ts";

export const codePrincipal = Effect.fn("Account.codePrincipal")(
  function* codePrincipal(token: CodeToken, purpose: CodePurpose) {
    const codes = yield* CodeRepository;
    const accounts = yield* AccountRepository;
    const now = yield* DateTime.now;
    const hash = yield* Effect.orDie(hashCode(token));
    const code = yield* codes.findUsable({ hash, now, purpose });

    if (Option.isNone(code)) {
      return Option.none();
    }

    const account = yield* accounts.find(code.value.subject);
    const requiredState = purpose === "activation" ? "Invited" : "Active";

    if (Option.isNone(account) || account.value.state._tag !== requiredState) {
      return Option.none();
    }

    const principal = Principal.cases.Person.make({
      client: "browser",
      memberships: [],
      personId: code.value.subject,
    });

    return Option.some(
      Principal.narrow(principal, {
        command: codePolicy[purpose].command,
        resource: { personId: code.value.subject },
      })
    );
  }
);
