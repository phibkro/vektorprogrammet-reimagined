/** C10 submit contact: validate, then enqueue the notifications in the caller's transaction. */
import { Effect } from "effect";

import { DepartmentRepository } from "../organisation/services.ts";
import { validationFailed } from "../shared/errors.ts";
import { Outbox } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput } from "../shared/validation.ts";
import {
  DEPARTMENT_UNAVAILABLE_MESSAGE,
  SupportTicket,
  contactReceiptNotice,
  supportTicketMessages,
} from "./supportTicket.ts";

const decodeSupportTicket = decodeInput(SupportTicket);

/**
 * RULE-156 + RULE-249. Anyone may submit (no capability). Invalid input or an
 * unknown/inactive department sends nothing. Delivery happens after commit.
 */
export const submitContact = Effect.fn("submitContact")(function* submitContact(
  input: unknown
) {
  yield* InTransaction;
  const ticket = yield* decodeSupportTicket(input);
  const departments = yield* DepartmentRepository;

  const department = yield* departments
    .findById(ticket.departmentId)
    .pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(
          validationFailed(["departmentId"], DEPARTMENT_UNAVAILABLE_MESSAGE)
        )
      )
    );

  if (!department.active) {
    return yield* validationFailed(
      ["departmentId"],
      DEPARTMENT_UNAVAILABLE_MESSAGE
    );
  }

  const outbox = yield* Outbox;

  const messageIds = yield* outbox.enqueue(
    supportTicketMessages(ticket, department)
  );

  return {
    departmentId: department.id,
    messageIds,
    notice: contactReceiptNotice(department),
  };
});
