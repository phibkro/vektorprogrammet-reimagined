/**
 * Spec 0017, falsifier 3: the store ports are the domain's. Each service below was declared in `packages/db` or in the
 * web app before; a program that needs one now imports it from `@vektorprogrammet/domain` and never from the adapter.
 */
import { assert, describe, it } from "@effect/vitest";
import { Record as Rec } from "effect";

import * as domain from "../../src/index.ts";

const PORTS = {
  CapturedMessageStore: domain.CapturedMessageStore,
  ImportTarget: domain.ImportTarget,
  OutboxDelivery: domain.OutboxDelivery,
  SessionDirectory: domain.SessionDirectory,
  SignInDirectory: domain.SignInDirectory,
  Transactor: domain.Transactor,
};

describe("the store ports (spec 0017)", () => {
  it("are exported by the domain, with the local fixture people", () => {
    for (const name of [
      ...Rec.keys(PORTS),
      "LOCAL_PEOPLE",
      "TargetWriteError",
    ]) {
      assert.property(domain, name);
    }
  });

  it("each port is a service whose key is in the domain's namespace", () => {
    for (const [name, port] of Rec.toEntries(PORTS)) {
      assert.match(
        port.key,
        new RegExp(`^@vektorprogrammet/domain/.+/${name}$`, "u")
      );
    }
  });
});
