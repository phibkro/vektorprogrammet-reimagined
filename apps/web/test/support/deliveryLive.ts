/**
 * The delivery stack over a disposable migrated database: the real repositories, the Better Auth adapter, the crypto, the
 * password hasher and the capture sender, so a test delivers outbox messages as the Worker does and reads the mailbox.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { SiteOrigin } from "@vektorprogrammet/domain";
import { Effect, Layer, Redacted } from "effect";

import { accountDeliveryLayer } from "../../src/server/accountDelivery";
import { authLayer } from "../../src/server/auth";
import { passwordHasherLayer } from "../../src/server/password";
import { captureSenderLayer } from "../../src/server/senders";
import { webCryptoLayer } from "../../src/server/webCrypto";
import { workspaceWriterLayer } from "../../src/server/workspace";

/** The origin that the links of the mail name. */
export const origin = "https://mail.example";

export const live = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) => {
    const infrastructure = Layer.mergeAll(
      DatabaseLive({ maxConnections: 8, url }),
      authLayer({
        BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
        HYPERDRIVE: { connectionString: Redacted.value(url) },
        SITE_URL: origin,
      }),
      passwordHasherLayer,
      webCryptoLayer,
      workspaceWriterLayer({ deployment: "local", mode: "dry-run" }),
      Layer.succeed(SiteOrigin)(origin)
    );

    const capture = captureSenderLayer.pipe(Layer.provideMerge(infrastructure));

    return accountDeliveryLayer.pipe(Layer.provideMerge(capture));
  })
).pipe(Layer.provideMerge(migratedTestDatabase), Layer.orDie);
