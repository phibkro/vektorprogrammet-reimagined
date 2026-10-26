/** C10 submit contact: validate, then enqueue the notifications in the caller's transaction. */
import { Effect } from "effect";

import * as Commands from "../kernel/commands.ts";
import { DepartmentRepository } from "../organisation/services.ts";
import { validationFailed } from "../shared/errors.ts";
import { Outbox } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import { ContactDomain, ContactRpc, submitContact } from "./declaration.ts";
import {
  DEPARTMENT_UNAVAILABLE_MESSAGE,
  contactReceiptNotice,
  supportTicketMessages,
} from "./supportTicket.ts";

export const ContactHandlers = ContactRpc.toLayer({
  /**
   * RULE-156 + RULE-249. Anyone may submit. Invalid input or an unknown/inactive department sends nothing.
   * Delivery happens after commit.
   */
  submitContact: ContactDomain.handle(submitContact, {
    resource: () => Effect.succeed({}),
    run: (ticket) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const departments = yield* DepartmentRepository;

        const department = yield* departments
          .findById(ticket.departmentId)
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(
                validationFailed(
                  ["departmentId"],
                  DEPARTMENT_UNAVAILABLE_MESSAGE
                )
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
      }),
  }),
});

/** The contact command behind the in-process client; see `Commands.inProcess`. */
export const withContact = Commands.inProcess(ContactRpc, ContactHandlers);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const ContactEndpoints = {
  submitContact: Commands.endpoint(submitContact, (payload) =>
    withContact((client) => client.submitContact(payload))
  ),
};
