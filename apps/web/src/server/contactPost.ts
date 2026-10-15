/**
 * The `/kontakt` form post (no JavaScript needed). Success → 303 to the
 * department's receipt page. A typed failure → the form is rendered again
 * (status from the error table's `formStatus`: 422 for validation, 429 for
 * the rate limit) with the visitor's values and the field messages.
 */
import { setResponseStatus } from "@tanstack/react-start/server";
import type { Failure } from "../lib/outcome";
import {
  contactCommand,
  prepareContact,
  readContactSubmission,
  type ContactValues,
} from "./contact";
import type { RequestContext } from "./env";
import { runPreparedCommand } from "./runtime";
import { requestScope } from "./scope";

/** What a failed post hands to the page render (via the server route's `next`). */
export interface ContactFormState {
  readonly values: ContactValues;
  readonly failure: Failure;
}

export const handleContactPost = <Next>(options: {
  readonly request: Request;
  readonly context: RequestContext;
  readonly next: (options: { context: { contactForm: ContactFormState } }) => Next;
}): Promise<Response | Next> =>
  options.request.formData().then((form) => {
    const submission = readContactSubmission(form, options.request.headers);
    return runPreparedCommand(requestScope(options.context), prepareContact(submission), () =>
      contactCommand(submission),
    ).then((outcome) => {
      if (outcome._tag === "Success") {
        return new Response(null, {
          status: 303,
          headers: { Location: `/kontakt/avdeling/${outcome.value.departmentId}?sendt=1` },
        });
      }
      setResponseStatus(outcome.formStatus);
      return options.next({
        context: { contactForm: { values: submission.values, failure: outcome } },
      });
    });
  });
