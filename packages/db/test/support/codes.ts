/** What the delivery of a code mail does to the store, in the two transactions that it uses (spec 0024). */
import { CodeRepository } from "@vektorprogrammet/domain";
import type { Code, Locked } from "@vektorprogrammet/domain";
import { Effect } from "effect";

/** Transaction 1 of the delivery: the code is stored `Unsent`, and nothing authenticates with it yet. */
export const issueUnsent = (
  locked: Locked<"Person">,
  code: Pick<Code, "expiresAt" | "hash" | "purpose">
) => CodeRepository.use((codes) => codes.issue(locked, code));

/** Both transactions' writes in one: the code is stored and acknowledged, as a delivered mail leaves it. */
export const issueUsable = Effect.fnUntraced(function* issueUsable(
  locked: Locked<"Person">,
  code: Pick<Code, "expiresAt" | "hash" | "purpose">
) {
  const codes = yield* CodeRepository;
  yield* codes.issue(locked, code);

  return yield* codes.acknowledge(locked, {
    hash: code.hash,
    purpose: code.purpose,
  });
});
