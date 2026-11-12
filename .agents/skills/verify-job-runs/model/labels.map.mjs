// Labels for readers inspecting a TLC state or transition.
export const readerActions = [];
export function state(v) {
  return `${v.outcome}; cursor ${v.cursor}; attempt ${v.attempt}${v.expired ? "; lease expired" : ""}`;
}
export function step(action, before, after) {
  if (
    before.outcome !== "failed" &&
    after.outcome === "failed" &&
    before.attempt === after.attempt
  )
    return "claim refuses exhausted attempts and records failed";
  if (!before.badReport && after.badReport)
    return "stale worker reports an outcome without a matching fenced write";
  if (before.outcome !== after.outcome)
    return `${before.outcome} → ${after.outcome}`;
  if (before.attempt !== after.attempt) return "claim or reclaim";
  if (before.cursor !== after.cursor) return "commit chunk and cursor";
  if (!before.expired && after.expired) return "lease expires";
  return action;
}
export function cause(_v, _facts, invariant) {
  if (invariant === "HonestReports")
    return "F-b: a rejected fenced write was reported as committed";
  if (invariant === "DoneHasEnd") return "F-c: a done row has no ended_at";
  if (invariant === "EventuallyTerminal")
    return "F-a: crash-only reclaims continue beyond maxAttempts";
  return `Job-run property ${invariant} does not hold`;
}
