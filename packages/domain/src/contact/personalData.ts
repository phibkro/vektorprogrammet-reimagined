/**
 * What the contact form collects (spec 0007b, falsifier 1). The form's input schema is `SupportTicket`; each of its
 * fields is declared here, and the privacy notice on the form (`apps/web`'s `PrivacyNotice`) lists exactly the ones that
 * are personal. The values leave the form in outbox messages (`outbox.payload`), whose retention they take. That period
 * is for the copy in this system: a mailbox and a Slack channel keep their own copy by rules that this system does not
 * apply, so the recipients' text says so (spec 0007b R3 item 31).
 */
import { collected, form, notCollected } from "../personalData/forms.ts";
import { SupportTicket } from "./supportTicket.ts";

const RECIPIENTS = {
  en: "The department you write to (its mailbox and Slack channel) and the organisation's notification channel. Each keeps its own copy of the message until someone deletes it there; the time under “Kept for” applies to the copy in this system only",
  no: "Avdelingen du skriver til (postkasse og Slack-kanal) og organisasjonens varslingskanal. Hver av dem beholder sin egen kopi av meldingen til noen sletter den der; tiden under «Lagres» gjelder bare kopien i dette systemet",
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
