/** The privacy scan of the deployed run can find what it looks for, and passes ids and instants. */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr } from "effect";
import { Base64Url } from "effect/encoding";

import { personalDataIn } from "./cloud/privacy.ts";
import { decodedFailureTokens } from "./support/failureToken.ts";

const MARKERS = [
  "Renewal Subject abc12",
  "renewal.subject.abc12@person.example",
  "+47 9900000001",
] as const;

/** The shape of what the Workflows API returns for an instance of the renewal: ids and instants. */
const API_JSON = `{
  "output": {
    "_tag": "Stopped",
    "membershipId": 900000001,
    "personId": 900000002,
    "renewalId": "stop-abc12",
    "stoppedAt": "2026-10-27T19:01:26.591Z"
  },
  "params": {
    "actorId": 900000002,
    "dueAt": "2026-10-27T19:11:26.000Z",
    "end": { "term": "HOST", "year": 2027 },
    "membershipId": 900000001,
    "personId": 900000002,
    "renewalId": "stop-abc12"
  },
  "status": "complete"
}`;

describe("the privacy scan of the Workflows API's JSON", () => {
  it("finds nothing in ids and instants", () => {
    assert.deepStrictEqual(personalDataIn(API_JSON, MARKERS), []);
  });

  it("finds a planted name, email address and phone number, by position and case-insensitively", () => {
    assert.deepStrictEqual(
      personalDataIn(`{"note":"RENEWAL SUBJECT ABC12"}`, MARKERS),
      ["marker 0"]
    );
    assert.deepStrictEqual(
      personalDataIn(`{"note":"+47 9900000001"}`, MARKERS),
      ["marker 2"]
    );
    assert.deepStrictEqual(
      personalDataIn(
        `{"note":"renewal.subject.abc12@person.example"}`,
        MARKERS
      ),
      ["marker 1", "an at sign"]
    );
  });

  it("finds an email address that is nobody's marker", () => {
    assert.deepStrictEqual(personalDataIn(`{"note":"x@y.z"}`, MARKERS), [
      "an at sign",
    ]);
  });

  it("never returns the marker itself", () => {
    const found = personalDataIn(`{"note":"+47 9900000001"}`, MARKERS);

    assert.isFalse(Arr.some(found, (label) => label.includes("9900000001")));
  });

  it("finds a marker inside the decoded Cause of a failure token, which the bare text hides", () => {
    const cause = `{"errors":[["error",[["_tag","TransientFailure"],["name","Renewal Subject abc12"]]]]}`;
    const text = `{"error":{"name":"Error","message":"[alchemy-workflow-failure:v1]mac-mac_1:${Base64Url.encode(cause)}"}}`;

    assert.isFalse(text.toLowerCase().includes("renewal subject abc12"));
    assert.deepStrictEqual(personalDataIn(text, MARKERS), ["marker 0"]);
  });

  it("passes a failure token whose Cause holds ids, counts and a stack", () => {
    const cause = `{"instanceId":"retry-abc12","errors":[["error",[["_tag","TransientFailure"],["attempt",1],["stack","TransientFailure\\n    at extend (file:///bundle/renewalWorker.js:253:1124)"]]]]}`;
    const text = `{"error":{"name":"Error","message":"[alchemy-workflow-failure:v1]mac-mac_1:${Base64Url.encode(cause)}"}}`;

    assert.deepStrictEqual(personalDataIn(text, MARKERS), []);
  });

  it("skips a token whose payload is not base64url, and reads the ones around it", () => {
    const cause = `{"note":"+47 9900000001"}`;

    const text = `[alchemy-workflow-failure:v1]mac:a ... [alchemy-workflow-failure:v1]mac:${Base64Url.encode(cause)}`;

    assert.deepStrictEqual(decodedFailureTokens(text), [cause]);
    assert.deepStrictEqual(personalDataIn(text, MARKERS), ["marker 2"]);
  });
});
