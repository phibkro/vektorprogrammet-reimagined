/**
 * The deployment a Worker runs as, decoded once at the composition root.
 * Behaviour that differs by deployment (message senders, the test actor)
 * switches on this decoded value, never on a raw string.
 */
import { Effect, Schema } from "effect";

export const Deployment = Schema.Literals(["local", "preview", "production"]);
export type Deployment = typeof Deployment.Type;

const decode = Schema.decodeUnknownEffect(Deployment);

/**
 * Decodes the `DEPLOYMENT` var. A missing or unknown value is a defect: the
 * Worker is misconfigured and must not guess (guessing `production` would
 * mail real departments from a preview; guessing `local` would expose the
 * test actor).
 */
export const decodeDeployment = (raw: unknown): Effect.Effect<Deployment> =>
  decode(raw).pipe(Effect.orDie);
