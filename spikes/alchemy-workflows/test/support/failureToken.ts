/**
 * The failure token of an Alchemy workflow attempt. When a task fails, the error that the engine stores for the attempt
 * is `[alchemy-workflow-failure:v1]<mac>:<payload>`, where the payload is base64url of a JSON document: the workflow's
 * identity, the instance, the step and the error's Cause (its fields and its stack). The engine's files and the
 * Workflows API show only the base64, so a scan for a name would pass over a name inside it. `withDecodedFailureTokens`
 * returns the text with what its tokens hold appended, decoded: every privacy scan reads that, never the bare text.
 */
import { Array as Arr, Result } from "effect";
import { Base64Url } from "effect/encoding";

const FAILURE_TOKEN =
  /\[alchemy-workflow-failure:v1\][A-Za-z0-9_-]+:(?<payload>[A-Za-z0-9_-]+)/gu;

/** The decoded payload of every failure token in `text`; a payload that is not base64url is skipped. */
export const decodedFailureTokens = (text: string): readonly string[] =>
  Arr.flatMap([...text.matchAll(FAILURE_TOKEN)], (match) =>
    Result.match(Base64Url.decodeString(match.groups?.payload ?? ""), {
      onFailure: () => [],
      onSuccess: (decoded) => [decoded],
    })
  );

/** `text`, then what its failure tokens hold, decoded, one document per line. */
export const withDecodedFailureTokens = (text: string): string =>
  Arr.join([text, ...decodedFailureTokens(text)], "\n");
