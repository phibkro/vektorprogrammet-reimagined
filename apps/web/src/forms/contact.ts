import { Contact } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import { Text, formSchema, wholeNumber } from "./formSchema";

/**
 * C10: the contact form. `captcha` is the Turnstile widget's place for a message (its token travels in
 * `cf-turnstile-response`, which the widget puts in the page, not in a value of this form), and no field reads it.
 */
export const ContactForm = formSchema(
  Schema.Struct({
    captcha: Text,
    departmentId: Text,
    email: Text,
    message: Text,
    name: Text,
    subject: Text,
  }),
  Contact.submitContact.payloadSchema,
  (text) => ({
    departmentId: wholeNumber(text.departmentId),
    email: text.email ?? "",
    message: text.message ?? "",
    name: text.name ?? "",
    subject: text.subject ?? "",
  })
);
