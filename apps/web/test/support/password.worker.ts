/** Test-only Worker: bundle the real password adapter, not a substitute, into workerd. */
import { verifyPassword as defaultVerifier } from "better-auth/crypto";
import { Effect, Exit } from "effect";

import { hashPassword, verifyPassword } from "../../src/server/password";
import { bcryptFixtures, fixturePassword } from "./passwordFixtures";

const verifies = (hash: string, password: string) =>
  Effect.promise(() => verifyPassword({ hash, password }));

export default {
  fetch: (): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* passwordChecks() {
        const variants = yield* Effect.forEach(bcryptFixtures, (hash) =>
          Effect.gen(function* checkVariant() {
            return {
              matches: yield* verifies(hash, fixturePassword),
              wrong: yield* verifies(hash, "wrong password"),
            };
          })
        );

        const newHash = yield* Effect.promise(() =>
          hashPassword(fixturePassword)
        );

        const defaultResult = yield* Effect.exit(
          Effect.tryPromise(() =>
            defaultVerifier({
              hash: bcryptFixtures[0],
              password: fixturePassword,
            })
          )
        );

        const tooLongHash = yield* Effect.exit(
          Effect.tryPromise(() => hashPassword("ø".repeat(37)))
        );

        return Response.json({
          defaultRejected: Exit.isFailure(defaultResult),
          newHashCost12: /^\$2[ab]\$12\$/u.test(newHash),
          newHashVerifies: yield* verifies(newHash, fixturePassword),
          overLimitRejected:
            !(yield* verifies(bcryptFixtures[0], "ø".repeat(37))) &&
            Exit.isFailure(tooLongHash),
          truncatedRejected: !(yield* verifies(
            bcryptFixtures[0].slice(0, -1),
            fixturePassword
          )),
          variants,
        });
      })
    ),
};
