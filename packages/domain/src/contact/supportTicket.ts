/**
 * C10 contact form (RULE-156) and its notifications (RULE-249).
 *
 * RULE-327 replacement (Checkpoint 1): the visitor picks the department; no IP
 * geolocation. Spam protection (RULE-167, Turnstile) is verified by `apps/web`
 * before `submitContact` runs, because siteverify is provider I/O.
 */
import { Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { Department } from "../organisation/department.ts";
import { DepartmentId } from "../shared/ids.ts";
import type { OutboxMessage } from "../shared/outbox.ts";
import { EmailAddressInput, REQUIRED_FIELD_MESSAGE, requiredText } from "../shared/validation.ts";

export const DEPARTMENT_UNAVAILABLE_MESSAGE =
  "Klarte ikke sende melding til denne avdelingen. Send oss en mail isteden.";

const required = (maxLength: number) =>
  requiredText({ maxLength }).annotateKey({ messageMissingKey: REQUIRED_FIELD_MESSAGE });

/** RULE-156: name, a valid e-mail, subject, message and the chosen department. */
export const SupportTicket = Schema.Struct({
  name: required(255),
  email: EmailAddressInput.annotateKey({ messageMissingKey: REQUIRED_FIELD_MESSAGE }),
  subject: required(255),
  message: required(10_000),
  departmentId: DepartmentId.annotate({ message: DEPARTMENT_UNAVAILABLE_MESSAGE }).annotateKey({
    messageMissingKey: DEPARTMENT_UNAVAILABLE_MESSAGE,
  }),
});
export type SupportTicket = typeof SupportTicket.Type;

/** Flash text after a successful submit (legacy wording). */
export const contactReceiptNotice = (department: Pick<Department, "email">): string =>
  `Kontaktforespørsel sendt til ${department.email}, takk for henvendelsen!`;

/**
 * RULE-249: the notifications for one ticket, in delivery order:
 * department e-mail, receipt e-mail, the department's Slack channel when it has
 * one, then #notifications.
 */
export const supportTicketMessages = (
  ticket: SupportTicket,
  department: Pick<Department, "name" | "email" | "slackChannel">,
): NonEmptyReadonlyArray<OutboxMessage> => {
  const departmentEmail: OutboxMessage = {
    _tag: "Email",
    to: department.email,
    replyTo: ticket.email,
    subject: `Henvendelse fra kontaktskjema: ${ticket.subject}`,
    text: [
      `Ny henvendelse fra ${ticket.name} (${ticket.email}).`,
      `Emne: ${ticket.subject}`,
      "",
      ticket.message,
    ].join("\n"),
  };
  const receipt: OutboxMessage = {
    _tag: "Email",
    to: ticket.email,
    replyTo: department.email,
    subject: `Kvittering: ${ticket.subject}`,
    text: [
      `Hei ${ticket.name},`,
      "",
      `Vi har mottatt henvendelsen din og videresendt den til ${department.email}.`,
      "",
      `Emne: ${ticket.subject}`,
      "",
      ticket.message,
    ].join("\n"),
  };
  const notifications: OutboxMessage = {
    _tag: "SlackPost",
    target: { _tag: "Notifications" },
    text: [
      `${department.name}: Ny melding mottatt fra *${ticket.name}*. Meldingen ble sendt fra et kontaktskjema på vektorprogrammet.no.`,
      `Emne: \`${ticket.subject}\``,
      `Meldingen har blitt videresendt til ${department.email}`,
    ].join("\n"),
  };
  if (department.slackChannel === null) return [departmentEmail, receipt, notifications];
  const departmentSlack: OutboxMessage = {
    _tag: "SlackPost",
    target: { _tag: "DepartmentChannel", channel: department.slackChannel },
    text: [
      `Ny henvendelse fra ${ticket.name} (${ticket.email}).`,
      `Emne: \`${ticket.subject}\``,
      "```",
      ticket.message,
      "```",
    ].join("\n"),
  };
  return [departmentEmail, receipt, departmentSlack, notifications];
};
