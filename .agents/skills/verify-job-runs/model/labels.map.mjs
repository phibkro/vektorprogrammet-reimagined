// Labels for readers inspecting a TLC state or transition.
export const readerActions = [];
export function state(v) {
  return `${v.outcome}; cursor ${v.cursor}; attempt ${v.attempt}${v.expired ? "; lease expired" : ""}`;
}
export function step(action, before, after) {
  if (before.outcome !== after.outcome) return `${before.outcome} → ${after.outcome}`;
  if (before.attempt !== after.attempt) return "claim or reclaim";
  if (before.cursor !== after.cursor) return "commit chunk and cursor";
  if (!before.expired && after.expired) return "lease expires";
  return action;
}
export function cause(_v, _facts, invariant) {
  return `Job-run property ${invariant} does not hold`;
}
