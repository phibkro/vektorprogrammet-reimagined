import { Schema } from "effect";

/** The queue did not accept a batch of ids. The cause is kept for diagnosis; a message holds only ids, so nothing in it is personal. */
export class QueueSendFailed extends Schema.TaggedError<
  QueueSendFailed,
  { readonly brand: unique symbol }
>()("QueueSendFailed", { cause: Schema.Defect() }) {}
