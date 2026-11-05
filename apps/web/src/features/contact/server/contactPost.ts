/**
 * The `/kontakt` form post (no JavaScript needed). Success → 303 to the
 * department's receipt page. A typed failure → the form is rendered again
 * (status from the error table's `formStatus`: 422 for validation, 429 for
 * the rate limit) with the visitor's values and the field messages.
 */
import { setResponseStatus } from "@tanstack/react-start/server";
import { Predicate } from "effect";

import type { RequestContext } from "../../../server/http/context";
import { requestScope } from "../../../server/http/scope";
import { runPreparedCommand } from "../../../server/runtime";
import type { ContactFormState } from "../formState";
import { contactCommand, prepareHuman, readContactSubmission } from "./contact";

export const handleContactPost = <Next>(options: {
  readonly request: Request;
  readonly context: RequestContext;
  readonly next: (options: {
    context: { contactForm: ContactFormState };
  }) => Next;
}): Promise<Response | Next> =>
  options.request.formData().then((form) => {
    const submission = readContactSubmission(form, options.request.headers);

    return runPreparedCommand(
      requestScope(options.context),
      prepareHuman(submission),
      () => contactCommand(submission)
    ).then((outcome) => {
      if (Predicate.isTagged(outcome, "Success")) {
        return new Response(null, {
          headers: {
            Location: `/kontakt/avdeling/${outcome.value.departmentId}?sendt=1`,
          },
          status: 303,
        });
      }

      setResponseStatus(outcome.formStatus);

      return options.next({
        context: {
          contactForm: { failure: outcome, values: submission.values },
        },
      });
    });
  });
