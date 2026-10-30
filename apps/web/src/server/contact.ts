/**
 * C10 `/kontakt` form post (RULE-156, RULE-167, RULE-249). Works without
 * JavaScript: the browser posts the form to `/kontakt`, the server route reads
 * it here (outside Effect), and the pipeline runs as one prepared command:
 *
 *   prepare (no transaction): per-IP rate limit → Turnstile siteverify
 *   command (transaction):    ContactEndpoints.submitContact → outbox rows (delivered after commit)
 *
 * A rejected captcha never reaches `submitContact`, so nothing is enqueued.
 */
import { ContactEndpoints } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Record as Rec } from "effect";

import { CONTACT_FIELDS, ContactForm } from "../forms/contact";
import { textOf } from "../forms/formSchema";
import type { FormText } from "../forms/formSchema";
import { ContactRateLimiter } from "./rateLimit";
import { TURNSTILE_RESPONSE_FIELD, TurnstileVerifier } from "./turnstile";

/** The posted values of the form's own fields, as typed; echoed back when the form is shown again. */
export type ContactValues = FormText;

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
  const text = textOf(form);
  const token = text[TURNSTILE_RESPONSE_FIELD] ?? "";

  return {
    captchaToken: token === "" ? null : token,
    remoteIp: headers.get("CF-Connecting-IP"),
    values: Rec.filter(text, (_, name) => Arr.contains(CONTACT_FIELDS, name)),
  };
};

/** Step 1, outside the transaction: rate limit, then RULE-167. */
export const prepareHuman = (
  submission: Pick<ContactSubmission, "remoteIp" | "captchaToken">
) =>
  Effect.gen(function* runPreparation() {
    const limiter = yield* ContactRateLimiter;
    yield* limiter.check(submission.remoteIp);
    const verifier = yield* TurnstileVerifier;
    yield* verifier.verify({
      remoteIp: submission.remoteIp,
      token: submission.captchaToken,
    });
  });

/** Step 2, inside the transaction: the domain command decodes and validates (RULE-156), the form's payload. */
export const contactCommand = (submission: ContactSubmission) =>
  ContactEndpoints.submitContact(ContactForm.payloadOf(submission.values));
