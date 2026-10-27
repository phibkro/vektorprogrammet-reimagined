/** The fake mailbox used only by local and preview transports. */
import type { TransportMessage } from "@vektorprogrammet/domain";
import { Context, DateTime, Effect, Layer } from "effect";

import { Drizzle } from "../internal/drizzle.ts";
import { capturedMail } from "../schema.ts";

export class CapturedMailStore extends Context.Service<
  CapturedMailStore,
  {
    readonly record: (
      message: Extract<TransportMessage, { readonly _tag: "Email" }>
    ) => Effect.Effect<void>;
  }
>()("@vektorprogrammet/db/CapturedMailStore") {}

export const CapturedMailStoreLive = Layer.effect(
  CapturedMailStore,
  Effect.gen(function* CapturedMailStoreLive() {
    const db = yield* Drizzle;

    return CapturedMailStore.of({
      record: Effect.fn("CapturedMailStore.record")(function* record(
        message: Extract<TransportMessage, { readonly _tag: "Email" }>
      ) {
        yield* db
          .insert(capturedMail)
          .values({
            recipient: message.to,
            sentAt: DateTime.toDateUtc(yield* DateTime.now),
            subject: message.subject,
            text: message.text,
          })
          .pipe(Effect.orDie);
      }),
    });
  })
);
