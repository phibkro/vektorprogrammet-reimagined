/**
 * The places that count as an Active administrator's (spec 0006b R2): a place that ends after a cut-off and that an
 * Active account holds. The two decisions of the rule that an Active administrator is always left, `deactivate`
 * (`AccountRepository.isLastActiveAdmin`) and `revokeAdmin` (`AdminGrantRepository.revoke`), read exactly this, so they
 * cannot disagree about who counts. Whoever reads it decides on every administrator, so the caller holds the admin
 * list's lock: every command that can change a place or an account's state locks the list first, and nobody else can
 * change what this returns before the transaction ends.
 */
import { and, eq, gt } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import type { Drizzle } from "../internal/drizzle.ts";
import { account, adminGrant } from "../schema.ts";

export const activeAdminPlaces = (
  db: Drizzle["Service"],
  validAfter: DateTime.Utc
) =>
  db
    .select({ id: adminGrant.id, personId: adminGrant.personId })
    .from(adminGrant)
    .innerJoin(account, eq(account.personId, adminGrant.personId))
    .where(
      and(
        eq(account.state, "Active"),
        gt(adminGrant.until, DateTime.toDateUtc(validAfter))
      )
    )
    .pipe(Effect.orDie);
