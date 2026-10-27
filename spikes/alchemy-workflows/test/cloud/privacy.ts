/**
 * The privacy check of the deployed run: what the Workflows API returns for an instance (its parameters, its output, the
 * output and the errors of its steps) names ids and instants only. A marker is a name, an email address or a phone
 * number of the fixture; any at sign is an email address that nobody planned. The check is only worth something if it
 * can find, which `cloudPrivacy.test.ts` proves with a planted marker, also inside a failure token.
 *
 * A failed attempt's error is an opaque token that holds the error's Cause as base64url JSON, so the scan reads the text
 * together with what its tokens decode to (`withDecodedFailureTokens`), never the bare text.
 *
 * The result names the markers by position and never prints one: a failing assertion must not copy the personal data
 * it found into a log.
 */
import { Array as Arr } from "effect";

import { withDecodedFailureTokens } from "../support/failureToken.ts";

export const personalDataIn = (
  text: string,
  markers: readonly string[]
): readonly string[] => {
  const haystack = withDecodedFailureTokens(text).toLowerCase();

  const found = Arr.flatMap(markers, (marker, index) =>
    haystack.includes(marker.toLowerCase()) ? [`marker ${index}`] : []
  );

  return haystack.includes("@") ? [...found, "an at sign"] : found;
};
