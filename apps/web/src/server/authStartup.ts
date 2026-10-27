/** Fail before the Worker handles requests when its signing key is absent or too short. */
import { Effect, Schema } from "effect";

const AuthSecret = Schema.String.check(Schema.isMinLength(32));

export const isAuthSecret = Schema.is(AuthSecret);

/** Never include the rejected secret in the startup defect. */
export const validateAuthStartup = (secret: string | undefined): void => {
  Effect.runSync(
    isAuthSecret(secret)
      ? Effect.void
      : Effect.die("BETTER_AUTH_SECRET is missing or too short")
  );
};
