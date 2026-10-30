/**
 * Spec 0025 R5, the journey of a reviewer on the running app: `GET /api/platform` answers 200 with every check that the
 * domain asks of a platform, each held, and names the profile and the deployment. The stack is the browser tests' own
 * (`DEPLOYMENT=local`, a direct connection to a disposable migrated database), so this shows the adapter's constructs on
 * PostgreSQL; the same route on a pull request's Preview shows them through Hyperdrive (`.github/workflows/preview.yml`).
 */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import { requiredChecks } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Schema } from "effect";

const Report = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({ held: Schema.Boolean, id: Schema.String })
  ),
  deployment: Schema.String,
  problems: Schema.Array(Schema.String),
  profile: Schema.String,
});

test("spec 0025: the platform report holds every check that the domain asks for", async ({
  request,
}) => {
  const response = await request.get("/api/platform");

  expect(response.status()).toBe(200);

  const body = await Effect.runPromise(
    Schema.decodeUnknownEffect(Report)(await response.json())
  );

  expect(body.problems).toEqual([]);
  expect(body.profile).toBe("hyperdrive");
  expect(body.deployment).toBe("local");

  for (const { id } of requiredChecks) {
    expect(
      Arr.filter(body.checks, (check) => check.id === id && check.held)
    ).toHaveLength(1);
  }

  expect(Arr.every(body.checks, (check) => check.held)).toBe(true);
});
