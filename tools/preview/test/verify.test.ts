import { Array as Arr, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { requiredChecks } from "../../../apps/web/src/core/store/platformRequirements.ts";
import {
  assertHead,
  assertIsolation,
  assertPlatform,
  Version,
} from "../verify.ts";

describe("hosted preview evidence gates", () => {
  it("refuses stale and malformed deployed head metadata", () => {
    const headSha = "a".repeat(40);
    expect(() => {
      assertHead({ headSha }, headSha);
    }).not.toThrow();
    expect(() => {
      assertHead({ headSha: "b".repeat(40) }, headSha);
    }).toThrow();
    expect(
      Exit.isFailure(
        Effect.runSyncExit(Schema.decodeUnknownEffect(Version)({}))
      )
    ).toBe(true);
  });

  it("requires every platform check exactly once and held on Supabase preview", () => {
    const report = {
      checks: Arr.map(requiredChecks, ({ id }) => ({ held: true, id })),
      deployment: "preview",
      problems: [],
      profile: "supabase",
    };

    expect(() => {
      assertPlatform(report);
    }).not.toThrow();
    expect(() => {
      assertPlatform({ ...report, checks: report.checks.slice(1) });
    }).toThrow();
    const [first] = report.checks;

    if (first === undefined) {
      throw new Error("No required platform checks");
    }

    expect(() => {
      assertPlatform({ ...report, checks: [...report.checks, first] });
    }).toThrow();
    expect(() => {
      assertPlatform({
        ...report,
        checks: Arr.map(report.checks, (check) => ({ ...check, held: false })),
      });
    }).toThrow();
    expect(() => {
      assertPlatform({ ...report, deployment: "production" });
    }).toThrow();
    expect(() => {
      assertPlatform({ ...report, problems: ["failure"] });
    }).toThrow();
  });

  it("requires all three isolation levels and no reported problems", () => {
    const report = {
      probe: "serializable",
      problems: [],
      roleDefault: "read committed",
      transactor: "read committed",
    };

    expect(() => {
      assertIsolation(report);
    }).not.toThrow();

    for (const field of ["transactor", "probe", "roleDefault"] as const) {
      expect(() => {
        assertIsolation({ ...report, [field]: "wrong" });
      }).toThrow();
    }

    expect(() => {
      assertIsolation({ ...report, problems: ["failure"] });
    }).toThrow();
  });
});
