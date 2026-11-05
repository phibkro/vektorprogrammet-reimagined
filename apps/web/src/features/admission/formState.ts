import type { FormText } from "../../forms/formSchema";
import type { Failure } from "../../http/outcome";

/** What a failed post hands to the page render. */
export interface ApplicationFormState {
  readonly values: FormText;
  readonly failure: Failure;
}

/** What a failed verification hands to its page. */
export interface VerifyState {
  readonly failure: Failure;
}
