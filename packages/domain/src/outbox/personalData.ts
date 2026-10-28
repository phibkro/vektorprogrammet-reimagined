/**
 * What the outbox declares about its stored columns (spec 0007b): messages that carry e-mail addresses and text, kept
 * for the period of `Periods.outboxRows`. The rows are transport copies, so the export leaves them out, with the reason,
 * and erasure removes the ones that are addressed to the person.
 */
import {
  Rules,
  columns,
  erased,
  exported,
  keyed,
  notPersonal,
  personal,
  relation,
  table,
} from "../personalData/declaration.ts";
import { durationWords } from "../personalData/duration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn } from "../personalData/retentions.ts";

const outbox = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "delivery",
        retention: afterColumn("created_at", Periods.outboxRows, {
          en: "the message was queued",
          no: "meldingen ble lagt i kø",
        }),
      }),
      ["last_error", "payload"]
    ),
    ...columns(
      notPersonal(
        "Delivery bookkeeping (counts, times, status, a random claim token and the kind); it holds no value about a person"
      ),
      [
        "attempts",
        "claim_token",
        "claimed_until",
        "created_at",
        "delivered_at",
        "id",
        "kind",
        "next_attempt_at",
        "queued_at",
        "status",
      ]
    ),
  },
  person: relation({
    erase: erased.expire,
    export: exported.excluded(
      `Transport copies of mail that the system sent for other rows. They address people by e-mail address and carry other people's text (a contact form's message, a digest that lists members), and each lives ${durationWords(Periods.outboxRows.duration, "en")}`
    ),
    key: keyed.address("payload", ["to", "replyTo"]),
    references: {},
  }),
});

export const OutboxTables = { outbox } as const;
