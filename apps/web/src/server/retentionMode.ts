/**
 * What the nightly retention run does in a deployment (spec 0007b R4). Production runs it for real only when every
 * period that it applies is decided. While one is a proposal the run only counts (`ReportOnly`): it audits what it
 * would have deleted or anonymised and changes nothing, because what the operator has not approved cannot be taken
 * back. Local and preview deployments hold fake data, and run it for real.
 *
 * The decision reads the deployment, decoded once at the composition root, and the approval that `packages/domain`
 * declares for each period, and nothing else. `Match.exhaustive` makes a new deployment decide too.
 */
import {
  Catalog,
  retentionIsProposed,
  retentionRules,
} from "@vektorprogrammet/domain";
import type { RetentionMode, RetentionRule } from "@vektorprogrammet/domain";
import { Array as Arr, Match } from "effect";

import type { Deployment } from "./deployment";

export const retentionModeFor = (
  deployment: Deployment,
  rules: readonly RetentionRule[] = retentionRules(Catalog)
): RetentionMode =>
  Match.value(deployment).pipe(
    Match.when("production", (): RetentionMode =>
      Arr.some(rules, (rule) => retentionIsProposed(rule.retention))
        ? "ReportOnly"
        : "Apply"
    ),
    Match.whenOr("local", "preview", (): RetentionMode => "Apply"),
    Match.exhaustive
  );
