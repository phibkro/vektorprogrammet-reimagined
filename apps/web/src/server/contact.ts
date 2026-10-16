/**
 * C10 `/kontakt` form post (RULE-156, RULE-167, RULE-249). Works without
 * JavaScript: the browser posts the form to `/kontakt`, the server route reads
 * it here (outside Effect), and the pipeline runs as one prepared command:
 *
 *   prepare (no transaction): per-IP rate limit → Turnstile siteverify
 *   command (transaction):    submitContact → outbox rows (delivered after commit)
 *
 * A rejected captcha never reaches `submitContact`, so nothing is enqueued.
 */
import { submitContact } from "@vektorprogrammet/domain";
import { Effect, Option, Schema } from "effect";

import { ContactRateLimiter } from "./rateLimit";
import { TURNSTILE_RESPONSE_FIELD, TurnstileVerifier } from "./turnstile";

/** The text fields of the form, as typed; echoed back when the form is shown again. */
export const CONTACT_FIELDS = [
  "name",
  "email",
  "subject",
  "message",
  "departmentId",
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

export type ContactValues = Readonly<Record<ContactField, string>>;

export interface ContactSubmission {
  readonly values: ContactValues;
  readonly captchaToken: string | null;
  readonly remoteIp: string | null;
}

/** Reads the posted form and the client IP. Pure; runs before the Effect program. */
export const readContactSubmission = (
  form: FormData,
  headers: Headers
): ContactSubmission => {
  const text = (name: string): string =>
    Option.getOrElse(
      Schema.decodeUnknownOption(Schema.String)(form.get(name)),
      () => ""
    );

  const token = text(TURNSTILE_RESPONSE_FIELD);

  return {
    captchaToken: token === "" ? null : token,
    remoteIp: headers.get("CF-Connecting-IP"),
    values: {
      departmentId: text("departmentId"),
      email: text("email"),
      message: text("message"),
      name: text("name"),
      subject: text("subject"),
    },
  };
};

/** Step 1, outside the transaction: rate limit, then RULE-167. */
export const prepareContact = (submission: ContactSubmission) =>
  Effect.gen(function* runPreparation() {
    const limiter = yield* ContactRateLimiter;
    yield* limiter.check(submission.remoteIp);
    const verifier = yield* TurnstileVerifier;
    yield* verifier.verify({
      remoteIp: submission.remoteIp,
      token: submission.captchaToken,
    });
  });

/** Step 2, inside the transaction: the domain command decodes and validates (RULE-156). */
export const contactCommand = (submission: ContactSubmission) => {
  const { departmentId, ...rest } = submission.values;

  return submitContact({
    ...rest,
    departmentId: /^\d+$/u.test(departmentId)
      ? Number(departmentId)
      : departmentId,
  });
};
