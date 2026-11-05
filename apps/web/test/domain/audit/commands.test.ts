import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Ref } from "effect";

import { AuditLog } from "../../../src/features/audit/domain/auditLog.ts";
import { AuditEndpoints } from "../../../src/features/audit/domain/commands.ts";
import {
  TestServices,
  asPrincipal,
  teamMemberBergen,
} from "../support/inMemory.ts";

describe("spec 0006 R1: audit reads", () => {
  it.effect("refuses a non-admin before reading the audit store", () =>
    Effect.gen(function* auditReadRefusesNonAdmin() {
      const log = yield* AuditLog;
      const calls = yield* Ref.make(0);

      const observed = AuditLog.of({
        ...log,
        latest: (limit) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(log.latest(limit))
          ),
      });

      const error = yield* Effect.flip(
        asPrincipal(teamMemberBergen)(
          AuditEndpoints.listAuditEntries({ limit: 2 })
        ).pipe(Effect.provideService(AuditLog, observed))
      );

      assert.isTrue(Predicate.isTagged(error, "Forbidden"));
      assert.strictEqual(yield* Ref.get(calls), 0);
    }).pipe(Effect.provide(TestServices))
  );
});
