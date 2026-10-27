/**
 * EX-0016: Better Auth's password callback ABI and the domain's PasswordHasher share bcryptjs 3.0.3. Its Web Crypto
 * randomness and pure-JavaScript bcrypt run on workerd; it accepts $2y$, $2a$ and $2b$ without rehashing.
 * Retire this boundary if Better Auth provides a Worker-compatible bcrypt adapter with the same semantics.
 */
import { BASE_ERROR_CODES } from "@better-auth/core/error";
import { PasswordHash, PasswordHasher } from "@vektorprogrammet/domain";
import { compare, hash, truncates } from "bcryptjs";
import { APIError } from "better-auth/api";
import { Effect, Layer, Schema } from "effect";

import { AuthBoundaryFailure } from "./authError";

const COST = 12;
const isPasswordHash = Schema.is(PasswordHash);

/** bcryptjs counts UTF-8 bytes and identifies passwords bcrypt would truncate. */
export const exceedsBcryptLimit = truncates;

/** Better Auth calls this for credential writes and for the dummy hash of an unknown sign-in. */
export const hashPassword = (password: string): Promise<string> => {
  if (exceedsBcryptLimit(password)) {
    // oxlint-disable-next-line effect/no-native-promise-control-flow -- EX-0016: Better Auth's callback returns a native Promise.
    return Promise.reject(
      APIError.from("BAD_REQUEST", BASE_ERROR_CODES.PASSWORD_TOO_LONG)
    );
  }

  return hash(password, COST);
};

/** Malformed hashes and passwords that bcrypt would truncate cannot authenticate. */
export const verifyPassword = ({
  hash: storedHash,
  password,
}: {
  readonly hash: string;
  readonly password: string;
}): Promise<boolean> => {
  if (exceedsBcryptLimit(password) || !isPasswordHash(storedHash)) {
    // oxlint-disable-next-line effect/no-native-promise-control-flow -- EX-0016: Better Auth's callback returns a native Promise.
    return Promise.resolve(false);
  }

  return compare(password, storedHash);
};

/** Domain commands hash validated input before enqueueing the post-commit credential update. */
export const passwordHasherLayer: Layer.Layer<PasswordHasher> = Layer.succeed(
  PasswordHasher,
  PasswordHasher.of({
    hash: (password) =>
      Effect.tryPromise({
        catch: (cause) => new AuthBoundaryFailure({ cause }),
        try: () => hashPassword(password),
      }).pipe(
        Effect.map((value) => PasswordHash.make(value)),
        Effect.orDie
      ),
  })
);
