import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import { AccountState, PersonId, ssoAllowed } from "../../src/index.ts";
import { oslo, vaar } from "../support/calendar.ts";

const personId = PersonId.make(1);
const membership = { end: vaar(2026), start: vaar(2026) };
const first = oslo("2026-01-01T00:00:00");

const last = DateTime.subtract(oslo("2026-08-01T00:00:00"), {
  milliseconds: 1,
});

const after = oslo("2026-08-01T00:00:00");

const account = (state: AccountState) => ({ personId, state });

describe("RULE-104, 116, 125: SSO requires an active account and membership", () => {
  it("holds at both ends of the membership and stops at the first instant of the next semester", () => {
    const active = account(AccountState.cases.Active.make({}));
    assert.isTrue(ssoAllowed(active, [membership], first));
    assert.isTrue(ssoAllowed(active, [membership], last));
    assert.isFalse(ssoAllowed(active, [membership], after));
    assert.isFalse(ssoAllowed(active, [], first));
  });

  it("refuses absent, invited and deactivated accounts even with a current membership", () => {
    assert.isFalse(ssoAllowed(null, [membership], first));
    assert.isFalse(
      ssoAllowed(
        account(AccountState.cases.Invited.make({})),
        [membership],
        first
      )
    );
    assert.isFalse(
      ssoAllowed(
        account(AccountState.cases.Deactivated.make({})),
        [membership],
        first
      )
    );
  });
});
