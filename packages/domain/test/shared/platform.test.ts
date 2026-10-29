/**
 * Spec 0025, falsifiers 1 and 2: what the domain asks of a platform, and the one statement of what a report must hold.
 *
 * - Every check names a guarantee that `guarantees.ts` declares, and sits under the capability of that guarantee.
 * - A report that holds every required check passes; a report that leaves one out, one with a check that did not hold,
 *   and an empty report each fail, naming what is wrong (the check cannot pass by omission).
 * - A check that the adapter adds of its own counts: when it did not hold, the report fails.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Record as Rec } from "effect";

import { StoreGuarantees } from "../../src/shared/guarantees.ts";
import type { PlatformReport } from "../../src/shared/platformProbe.ts";
import {
  PlatformRequirements,
  isProbed,
  platformProblems,
  requiredChecks,
} from "../../src/shared/platformRequirements.ts";

const holding = (): PlatformReport => ({
  checks: Arr.map(requiredChecks, ({ id }) => ({
    detail: "as asked",
    held: true,
    id,
  })),
  profile: "test",
});

describe("spec 0025: what the domain asks of a platform", () => {
  it("F2: every required check names a guarantee of its own capability, and the ids are distinct", () => {
    const guaranteeOf = new Map(
      Arr.map(StoreGuarantees, (guarantee) => [guarantee.id, guarantee])
    );

    for (const [capability, requirement] of Rec.toEntries(
      PlatformRequirements
    )) {
      if (isProbed(requirement)) {
        for (const check of requirement.checks) {
          assert.strictEqual(
            guaranteeOf.get(check.guarantee)?.capability,
            capability,
            `${check.id} protects ${check.guarantee}, which is not a guarantee of ${capability}`
          );
        }
      }
    }

    const ids = Arr.map(requiredChecks, ({ id }) => id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.isAbove(ids.length, 0);
  });

  it("F2: a capability that is not probed says why and where its evidence is", () => {
    for (const requirement of Rec.values(PlatformRequirements)) {
      if (!isProbed(requirement)) {
        assert.isAbove(requirement.reason.length, 20);
        assert.isAbove(requirement.evidence.length, 20);
      }
    }
  });

  it("F2: a report that holds every required check has no problem (the control of the three below)", () => {
    assert.deepStrictEqual(platformProblems(holding()), []);
  });

  it("F2: a required check that the report leaves out is a problem that names it, and an empty report names every one", () => {
    const [first] = requiredChecks;
    const without = holding();

    const problems = platformProblems({
      ...without,
      checks: Arr.filter(without.checks, (check) => check.id !== first?.id),
    });

    assert.lengthOf(problems, 1);
    assert.include(problems[0], first?.id);
    assert.include(problems[0], "is not in the report");

    assert.lengthOf(
      platformProblems({ checks: [], profile: "test" }),
      requiredChecks.length
    );
  });

  it("F2: a check that did not hold is a problem with what it observed, and so is one that the adapter adds of its own", () => {
    const [first] = requiredChecks;

    const failing = platformProblems({
      ...holding(),
      checks: Arr.map(holding().checks, (check) =>
        check.id === first?.id
          ? {
              ...check,
              detail: "the second transaction took the lock",
              held: false,
            }
          : check
      ),
    });

    assert.lengthOf(failing, 1);
    assert.include(failing[0], "the second transaction took the lock");

    const extra = platformProblems({
      ...holding(),
      checks: [
        ...holding().checks,
        { detail: "the adapter's own", held: false, id: "adapter-own" },
      ],
    });

    assert.lengthOf(extra, 1);
    assert.include(extra[0], "adapter-own");
  });
});
