/** Administrator view of undelivered outbox rows, without payloads. */
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import { OutboxMessageId } from "../shared/ids.ts";

export const DeliveryState = Schema.Literals(["waiting", "retrying", "failed"]);

export type DeliveryState = typeof DeliveryState.Type;

/** The state of a row that is not delivered. A row that has failed once is retrying, whether or not the queue holds its id. */
export const deliveryState = (row: {
  readonly status: "pending" | "dead";
  readonly lastError: string | null;
}): DeliveryState => {
  if (row.status === "dead") {
    return "failed";
  }

  if (row.lastError !== null) {
    return "retrying";
  }

  return "waiting";
};

export const OutboxRowView = Schema.Struct({
  attempts: Schema.Int,
  id: OutboxMessageId,
  kind: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.DateTimeUtc,
  state: DeliveryState,
});

export type OutboxRowView = typeof OutboxRowView.Type;

export const OutboxOverview = Schema.Struct({
  counts: Schema.Struct({
    delivered: Schema.Int,
    failed: Schema.Int,
    pending: Schema.Int,
  }),
  /** The newest rows that are not delivered, at most `OVERVIEW_ROWS`. */
  open: Schema.Array(OutboxRowView),
});

export type OutboxOverview = typeof OutboxOverview.Type;

/** How many undelivered rows the overview lists. */
export const OVERVIEW_ROWS = 50;

export class OutboxReports extends Context.Service<
  OutboxReports,
  {
    readonly overview: Effect.Effect<OutboxOverview>;
  }
>()("@vektorprogrammet/domain/outbox/OutboxReports") {}
