/** RULE-104, 116, 125: SSO is allowed by an active account and a current membership, not a role. */
import { Array as Arr } from "effect";
import type { DateTime } from "effect";

import { membershipStateAt } from "../teams/term.ts";
import type { MembershipTerm } from "../teams/term.ts";
import type { Account } from "./entities.ts";

export const ssoAllowed = (
  account: Account | null,
  memberships: readonly MembershipTerm[],
  at: DateTime.DateTime
): boolean =>
  account?.state._tag === "Active" &&
  Arr.some(memberships, (term) => membershipStateAt(term, at) === "Active");
