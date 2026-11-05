import type { FormText } from "../../forms/formSchema";
import type { Failure } from "../../http/outcome";

/** The posted values echoed back when the form is shown again. */
export type ContactValues = FormText;

/** What a failed post hands to the page render. */
export interface ContactFormState {
  readonly values: ContactValues;
  readonly failure: Failure;
}
