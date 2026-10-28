/**
 * The delivery stack over a disposable migrated database: the real repositories, the Better Auth adapter, the crypto, the
 * password hasher and the capture sender, so a test delivers outbox messages as the Worker does and reads the mailbox.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  AuthTablesDatabaseUrl,
  authTablesRole,
} from "@vektorprogrammet/db/testing/auth-tables-role";
import type { CapturedMessageStore } from "@vektorprogrammet/domain";
import { OutboxMessageId, SiteOrigin } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { accountDeliveryLayer } from "../../src/server/accountDelivery";
import { authLayer } from "../../src/server/auth";
import { deliverOutbox } from "../../src/server/outboxDelivery";
import { passwordHasherLayer } from "../../src/server/password";
import { captureSenderLayer } from "../../src/server/senders";
import type { MessageSender } from "../../src/server/senders";
import { webCryptoLayer } from "../../src/server/webCrypto";
import { workspaceWriterLayer } from "../../src/server/workspace";

/** The origin that the links of the mail name. */
export const origin = "https://mail.example";

/**
 * The delivery stack with the transport that `sender` is: the capture sink, or a test's own provider. Better Auth's pool
 * is the role that holds privileges on the four `auth_*` tables only (spec 0017, falsifier 6), so every delivery here
 * proves that the library reads no domain table; the application's own database layer is built once and serves both.
 */
export const liveWith = (
  sender: Layer.Layer<MessageSender, never, CapturedMessageStore>
) =>
  Layer.unwrap(
    Effect.gen(function* buildDelivery() {
      const url = yield* TestDatabaseUrl;
      const authUrl = yield* AuthTablesDatabaseUrl;
      const database = DatabaseLive({ maxConnections: 8, url });

      const infrastructure = Layer.mergeAll(
        database,
        authLayer({
          BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
          HYPERDRIVE: { connectionString: Redacted.value(authUrl) },
          SITE_URL: origin,
        }).pipe(Layer.provide(database)),
        passwordHasherLayer,
        webCryptoLayer,
        workspaceWriterLayer({ deployment: "local", mode: "dry-run" }),
        Layer.succeed(SiteOrigin)(origin)
      );

      const capture = sender.pipe(Layer.provideMerge(infrastructure));

      return accountDeliveryLayer.pipe(Layer.provideMerge(capture));
    })
  ).pipe(
    Layer.provideMerge(authTablesRole),
    Layer.provideMerge(migratedTestDatabase),
    Layer.orDie
  );

export const live = liveWith(captureSenderLayer);

/**
 * Delivers every pending row, as the queue's consumer would once it had a message for each. The delivery is by id (spec
 * 0008b): a test that wants "whatever is waiting" names the rows by reading them.
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
