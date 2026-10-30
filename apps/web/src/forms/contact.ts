import { Contact } from "@vektorprogrammet/domain";
import { Record as Rec, Schema } from "effect";

import { Text, formSchema, wholeNumber } from "./formSchema";

/** The names of the contact form's inputs: the one list that the post and its echo read (the page's four fields are named by the page). `captcha` is the Turnstile widget's place for a message. */
const ContactText = Schema.Struct({
  captcha: Text,
  departmentId: Text,
  email: Text,
  message: Text,
  name: Text,
  subject: Text,
});

export const CONTACT_FIELDS = Rec.keys(ContactText.fields);

/**
 * C10: the contact form. The Turnstile token travels in `cf-turnstile-response`, which the widget puts in the page, not
 * in a value of this form, and no field reads it.
 */
export const ContactForm = formSchema(
  ContactText,
  Contact.submitContact.payloadSchema,
  (text) => ({
    departmentId: wholeNumber(text.departmentId),
    email: text.email ?? "",
    message: text.message ?? "",
    name: text.name ?? "",
    subject: text.subject ?? "",
  })
);
