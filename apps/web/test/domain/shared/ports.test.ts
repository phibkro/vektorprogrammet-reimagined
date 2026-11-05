/**
 * Spec 0017, falsifier 3: the store ports are the domain's. Each service below was declared in `packages/db` or in the
 * web app before; a program that needs one now imports it from `@vektorprogrammet/domain` and never from the adapter.
 */
import { assert, describe, it } from "@effect/vitest";
import { Record as Rec } from "effect";

import { CapturedMessageStore } from "../../../src/domain/outbox/captured.ts";
import { OutboxDelivery } from "../../../src/domain/outbox/delivery.ts";
import { Transactor } from "../../../src/domain/transactions/transactor.ts";
import { SignInDirectory } from "../../../src/features/accounts/domain/signInDirectory.ts";
import { ImportTarget } from "../../../src/features/organisation/domain/legacyImport.ts";

const PORTS = {
  CapturedMessageStore,
  ImportTarget,
  OutboxDelivery,
  SignInDirectory,
  Transactor,
};

describe("the store ports (spec 0017)", () => {
  it("each port is a service whose key is in the domain's namespace", () => {
    for (const [name, port] of Rec.toEntries(PORTS)) {
      assert.match(
        port.key,
        new RegExp(`^@vektorprogrammet/domain/.+/${name}$`, "u")
      );
    }
  });
});
