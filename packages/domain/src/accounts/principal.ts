/** A code opens a request-scoped, narrowed principal, never a Better Auth login session (spec 0007 R2). */
import { DateTime, Effect, Option, Predicate } from "effect";

import { CurrentPrincipal, Principal } from "../kernel/principal.ts";
import type { Principal as PrincipalValue } from "../kernel/principal.ts";
import type { Forbidden } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import { codePolicy, hashCode } from "./code.ts";
import type { CodePurpose, CodeToken } from "./code.ts";
import { CodeRepository } from "./codeRepository.ts";
import { AccountRepository } from "./services.ts";

/** A code principal was resolved from a usable code before the command is run: the resource is the person it names. */
export const codeResource = Effect.map(CurrentPrincipal, (principal) =>
  Predicate.isTagged(principal, "Person")
    ? { personId: principal.personId }
    : {}
);

/** The person that a principal is, `null` for anonymous and for a job. */
export const personOf = (principal: PrincipalValue): PersonId | null =>
  Predicate.isTagged(principal, "Person") ? principal.personId : null;

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

    const requiredState = codePolicy[purpose].account;

    if (requiredState !== null) {
      const account = yield* accounts.find(code.value.subject);

      if (
        Option.isNone(account) ||
        account.value.state._tag !== requiredState
      ) {
        return Option.none();
      }
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

/** What a refusal needs of a domain: its `forbidden`, which takes only that domain's own command and read names. */
interface Refuses<Command extends string> {
  readonly forbidden: (command: Command) => Forbidden;
}

/**
 * Runs `program` as the principal that a code opens, or refuses with `Forbidden` when the code is not usable. One
 * definition for every code purpose. The refusal names the command of the purpose (`codePolicy`), derived from the
 * purpose so that a call site cannot name another, and `domain.forbidden` takes only names of its own domain: a purpose
 * whose command another domain owns does not compile.
 */
export const runWithCode = Effect.fnUntraced(function* runWithCode<
  P extends CodePurpose,
  A,
  E,
  R,
>(
  domain: Refuses<(typeof codePolicy)[P]["command"]>,
  purpose: P,
  token: CodeToken,
  program: Effect.Effect<A, E, R | CurrentPrincipal>
) {
  const principal = yield* codePrincipal(token, purpose);

  if (Option.isNone(principal)) {
    return yield* domain.forbidden(codePolicy[purpose].command);
  }

  return yield* Effect.provideService(
    program,
    CurrentPrincipal,
    principal.value
  );
});
