import { assert, describe, it } from "@effect/vitest";
import { Forbidden, ValidationFailed } from "@vektorprogrammet/domain";

import { fieldErrors, formLevelMessage, success } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";

const refusal =
  "Den siste administratorplassen som varer etter dette semesteret kan ikke fjernes.";

describe("the form outcome mapping (issue 26)", () => {
  it("shows a validation issue on a hidden input as a form-level message", () => {
    const failure = failureOf(
      new ValidationFailed({ issues: [{ message: refusal, path: ["id"] }] })
    );

    assert.strictEqual(formLevelMessage(failure, new Set()), refusal);
    assert.strictEqual(
      formLevelMessage(failure, new Set(["personId", "until"])),
      refusal
    );
  });

  it("shows a validation issue that names no field as a form-level message", () => {
    const failure = failureOf(
      new ValidationFailed({ issues: [{ message: refusal, path: [] }] })
    );

    assert.strictEqual(formLevelMessage(failure, new Set(["id"])), refusal);
  });

  it("leaves an issue on a rendered field to that field, never twice", () => {
    const failure = failureOf(
      new ValidationFailed({
        issues: [{ message: "Ugyldig dato.", path: ["until"] }],
      })
    );

    assert.isNull(formLevelMessage(failure, new Set(["until"])));
    assert.deepStrictEqual(fieldErrors(failure), { until: ["Ugyldig dato."] });
  });

  it("splits a mixed failure: rendered fields keep theirs, the rest is form-level", () => {
    const failure = failureOf(
      new ValidationFailed({
        issues: [
          { message: "Ugyldig dato.", path: ["until"] },
          { message: "Ukjent plass.", path: ["id"] },
          { message: "Noe er galt.", path: [] },
        ],
      })
    );

    assert.strictEqual(
      formLevelMessage(failure, new Set(["until"])),
      "Ukjent plass. Noe er galt."
    );
  });

  it("shows every other failure, and nothing for a success or no result", () => {
    const forbidden = failureOf(new Forbidden({ command: "revokeAdmin" }));

    assert.strictEqual(
      formLevelMessage(forbidden, new Set(["id"])),
      forbidden.message
    );
    assert.isNull(formLevelMessage(success("ok"), new Set()));
    assert.isNull(formLevelMessage(null, new Set()));
    assert.isNull(formLevelMessage(undefined, new Set()));
  });
});
