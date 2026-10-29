/**
 * RULE-167 (provider changed to Turnstile at Checkpoint 2): the contact form
 * must pass spam protection before `submitContact` runs. Verification is
 * provider I/O, so it runs before the transaction opens. A rejection is a
 * `ValidationFailed` on the `captcha` field: the form is shown again and
 * nothing is enqueued.
 */
import { validationFailed } from "@vektorprogrammet/domain";
import type {
  IntegrationPort,
  ValidationFailed,
  IntegrationTypeId,
} from "@vektorprogrammet/domain";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const CAPTCHA_FIELD = "captcha";

export const CAPTCHA_REJECTED_MESSAGE =
  "Bekreft at du ikke er en robot, og prøv igjen.";

/** The form field Turnstile's widget fills in. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const captchaRejected = (): ValidationFailed =>
  validationFailed([CAPTCHA_FIELD], CAPTCHA_REJECTED_MESSAGE);

/** Spam protection: an integration port (ADR 0015, section 10), so `Transactor.run` refuses a program that requires it. */
export class TurnstileVerifier
  extends Context.Service<
    TurnstileVerifier,
    {
      verify: (input: {
        readonly token: string | null;
        readonly remoteIp: string | null;
      }) => Effect.Effect<void, ValidationFailed>;
    }
  >()("@vektorprogrammet/web/server/TurnstileVerifier")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationTypeId;
}

const SiteverifyResponse = Schema.Struct({
  "error-codes": Schema.optionalKey(Schema.Array(Schema.String)),
  success: Schema.Boolean,
});

/**
 * Cloudflare siteverify. Fails closed: a missing token, a negative answer, a
 * transport error or an unreadable answer all reject the submission.
 */
export const turnstileLiveLayer = (
  secret: Redacted.Redacted
): Layer.Layer<TurnstileVerifier, never, HttpClient.HttpClient> =>
  Layer.effect(
    TurnstileVerifier,
    Effect.gen(function* makeTurnstileLayer() {
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

      return TurnstileVerifier.of({
        verify: Effect.fn("TurnstileVerifier.verify")(function* verify({
          token,
          remoteIp,
        }) {
          if (token === null || token.trim() === "") {
            return yield* captchaRejected();
          }

          const body =
            remoteIp === null
              ? { response: token, secret: Redacted.value(secret) }
              : {
                  remoteip: remoteIp,
                  response: token,
                  secret: Redacted.value(secret),
                };

          const answer = yield* HttpClientRequest.post(SITEVERIFY_URL).pipe(
            HttpClientRequest.bodyUrlParams(body),
            http.execute,
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(SiteverifyResponse)
            ),
            Effect.tapError((error) =>
              Effect.logWarning("turnstile siteverify failed").pipe(
                Effect.annotateLogs({ error: String(error) })
              )
            ),
            Effect.orElseSucceed(() => ({ success: false }))
          );

          if (!answer.success) {
            return yield* captchaRejected();
          }

          return yield* Effect.void;
        }),
      });
    })
  );

/** Test Layer: accepts exactly `acceptedToken`, rejects everything else (including no token). */
export const turnstileTestLayer = (
  acceptedToken: string
): Layer.Layer<TurnstileVerifier> =>
  Layer.succeed(
    TurnstileVerifier,
    TurnstileVerifier.of({
      verify: ({ token }) =>
        token === acceptedToken ? Effect.void : Effect.fail(captchaRejected()),
    })
  );
