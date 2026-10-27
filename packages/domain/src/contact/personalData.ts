/**
 * What the contact form collects (spec 0007b, falsifier 1). The form's input schema is `SupportTicket`; each of its
 * fields is declared here, and the privacy notice on the form (`apps/web`'s `PrivacyNotice`) lists exactly the ones that
 * are personal. The values leave the form in outbox messages (`outbox.payload`), whose retention they take.
 */
import { collected, form, notCollected } from "../personalData/forms.ts";
import { SupportTicket } from "./supportTicket.ts";

const RECIPIENTS = {
  en: "The department you write to (its mailbox and Slack channel) and the organisation's notification channel",
  no: "Avdelingen du skriver til (postkasse og Slack-kanal) og organisasjonens varslingskanal",
};

const contact = {
  legalBasis: "legitimateInterest",
  purpose: "contact",
  recipients: RECIPIENTS,
  storedIn: "outbox.payload",
} as const;

export const ContactForm = form({
  fields: {
    departmentId: notCollected(
      "The department you chose to write to; it is the organisation's, not yours"
    ),
    email: collected({
      ...contact,
      label: { en: "Your e-mail address", no: "E-postadressen din" },
    }),
    message: collected({
      ...contact,
      label: { en: "Your message", no: "Meldingen din" },
    }),
    name: collected({
      ...contact,
      label: { en: "Your name", no: "Navnet ditt" },
    }),
    subject: collected({
      ...contact,
      label: { en: "The subject", no: "Emnet" },
    }),
  },
  form: "contact",
  schema: SupportTicket,
  title: { en: "Contact form", no: "Kontaktskjema" },
});
