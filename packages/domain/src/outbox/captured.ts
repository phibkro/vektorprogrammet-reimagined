/**
 * The fake mailbox and the fake Slack workspace of a non-production deployment (spec 0008). Only the capture sender
 * layer writes them, so a browser test can read what a person would have received and no real recipient can.
 *
 * `key` is the outbox row's id: the same message captured twice (a delivery that crashed before its acknowledgement
 * and was claimed again) is kept once, which is what a provider with an idempotency key does.
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { TransportMessage } from "../shared/outbox.ts";

export class CapturedMessageStore extends Context.Service<
  CapturedMessageStore,
  {
    readonly record: (
      message: TransportMessage,
      key: string
    ) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/domain/outbox/CapturedMessageStore") {}
