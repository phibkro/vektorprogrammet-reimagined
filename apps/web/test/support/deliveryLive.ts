/** Real SQL repositories, crypto and captured transports over a disposable migrated database. */
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import type { CapturedMessageStore } from "@vektorprogrammet/domain";
import { OutboxMessageId, SiteOrigin } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { accountDeliveryLayer } from "../../src/server/accountDelivery";
import { deliverOutbox } from "../../src/server/outboxDelivery";
import { captureSenderLayer } from "../../src/server/senders";
import type { MessageSender } from "../../src/server/senders";
import { webCryptoLayer } from "../../src/server/webCrypto";
import { workspaceWriterLayer } from "../../src/server/workspace";

/** The origin that the links of the mail name. */
export const origin = "https://mail.example";

/** Compose delivery against the request-independent database layer and captured sender. */
const liveWith = (
  sender: Layer.Layer<MessageSender, never, CapturedMessageStore>
) =>
  Layer.unwrap(
    Effect.gen(function* buildDelivery() {
      const url = yield* TestDatabaseUrl;
      const database = DatabaseLive({ maxConnections: 8, url });

      const infrastructure = Layer.mergeAll(
        database,
        webCryptoLayer,
        workspaceWriterLayer({ deployment: "local", mode: "dry-run" }),
        Layer.succeed(SiteOrigin)(origin)
      );

      const capture = sender.pipe(Layer.provideMerge(infrastructure));

      return accountDeliveryLayer({
        SITE_URL: origin,
        SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
        SUPABASE_SECRET_KEY: "test-secret-key",
        SUPABASE_URL: "http://127.0.0.1:54321",
      }).pipe(Layer.provideMerge(capture));
    })
  ).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);

export const live = liveWith(captureSenderLayer);

/**
 * Delivers due pending rows through the same id-based, lease-fenced claim used by the scheduled sweep.
 * The test names its rows explicitly; no Cloudflare Queue or separate process is involved.
 */
export const deliverPending = Effect.gen(function* deliverPending() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly id: number;
  }>`select id from outbox where status = 'pending' order by id`;

  return yield* deliverOutbox(
    Arr.map(rows, (row) => OutboxMessageId.make(String(row.id)))
  );
}).pipe(Effect.orDie);
