/**
 * The two posts of the public admission journey (spec 0009); neither needs JavaScript.
 *
 * - `/soknad/{department}`: the application. Prepare (no transaction): per-IP rate limit, Turnstile. Command (one
 *   transaction): `AdmissionEndpoints.submitApplication`, which stores the person, the application and the outbox
 *   message that carries the mail. Success is 303 to the page's own receipt; a typed failure renders the page again
 *   with what was typed and the field messages, as the contact form does (`contactPost.ts`).
 * - `/soknad/bekreft`: the button of the mail's link. It spends the single-use code (`verifyApplicantEmail`); the link's
 *   page shows one button so that a mail scanner that opens the link does not spend it.
 */
import { setResponseStatus } from "@tanstack/react-start/server";
import {
  AdmissionEndpoints,
  PersonalDataEndpoints,
} from "@vektorprogrammet/domain";
import { Effect, Predicate } from "effect";

import { ApplicationForm } from "../forms/admission";
import { textOf } from "../forms/formSchema";
import type { FormText } from "../forms/formSchema";
import type { Failure } from "../lib/outcome";
import { prepareHuman } from "./contact";
import type { RequestContext } from "./env";
import { runPreparedCommand } from "./runtime";
import { requestScope } from "./scope";
import { TURNSTILE_RESPONSE_FIELD } from "./turnstile";

/** What a failed post hands to the page render (via the server route's `next`). */
export interface ApplicationFormState {
  readonly values: FormText;
  readonly failure: Failure;
}

/** What a failed verification hands to its page. */
export interface VerifyState {
  readonly failure: Failure;
}

const seeOther = (location: string): Response =>
  new Response(null, { headers: { Location: location }, status: 303 });

export const handleApplicationPost = <Next>(options: {
  readonly request: Request;
  readonly context: RequestContext;
  readonly next: (options: {
    context: { applicationForm: ApplicationFormState };
  }) => Next;
}): Promise<Response | Next> =>
  options.request.formData().then((form) => {
    const values = textOf(form);
    const token = values[TURNSTILE_RESPONSE_FIELD] ?? "";

    return runPreparedCommand(
      requestScope(options.context),
      prepareHuman({
        captchaToken: token === "" ? null : token,
        remoteIp: options.request.headers.get("CF-Connecting-IP"),
      }),
      () => AdmissionEndpoints.submitApplication(ApplicationForm.read(form))
    ).then((outcome) => {
      if (Predicate.isTagged(outcome, "Success")) {
        return seeOther(`${new URL(options.request.url).pathname}?sendt=1`);
      }

      setResponseStatus(outcome.formStatus);

      return options.next({
        context: { applicationForm: { failure: outcome, values } },
      });
    });
  });

export const handleVerifyPost = <Next>(options: {
  readonly request: Request;
  readonly context: RequestContext;
  readonly next: (options: { context: { verify: VerifyState } }) => Next;
}): Promise<Response | Next> =>
  options.request
    .formData()
    .then((form) =>
      runPreparedCommand(requestScope(options.context), Effect.void, () =>
        PersonalDataEndpoints.verifyApplicantEmail({
          code: textOf(form).kode ?? "",
        })
      )
    )
    .then((outcome) => {
      if (Predicate.isTagged(outcome, "Success")) {
        return seeOther("/soknad/bekreft?bekreftet=1");
      }

      setResponseStatus(outcome.formStatus);

      return options.next({ context: { verify: { failure: outcome } } });
    });
