import { Conflict, InTransaction } from "@vektorprogrammet/domain";
import type { Locked } from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import type { Owned } from "../aggregate/model.ts";
import type { Drizzle } from "../internal/drizzle.ts";
import { companyAddress } from "../schema.ts";

/** The Person-owned subset of the mixed namespace; Aggregates fills and checks its person_id. */
const personClaims = {
  owner: companyAddress.personId,
  ownerKey: "personId",
  root: roots.Person,
  state: undefined,
  stateKey: undefined,
  table: companyAddress,
} satisfies Owned<"Person", typeof companyAddress, "personId">;

const addressConflict = (entity: "Person" | "Team", id: number) =>
  new Conflict({
    entity,
    key: String(id),
    message: "Vektor-adressen er allerede i bruk.",
  });

/** Claim the new address before releasing the old one: colliding writers serialize on the unique index. */
export const claimPersonAddress = Effect.fn("CompanyAddress.claimPerson")(
  function* claimPersonAddress(
    aggregates: Aggregates["Service"],
    locked: Locked<"Person">,
    address: string
  ) {
    yield* InTransaction;

    const rows = yield* aggregates
      .insert(
        locked,
        personClaims,
        { address, teamId: null },
        { action: "ignore" }
      )
      .pipe(Effect.orDie);

    return rows.length === 1
      ? yield* Effect.void
      : yield* addressConflict("Person", locked.id);
  }
);

export const releasePersonAddress = Effect.fn("CompanyAddress.releasePerson")(
  function* releasePersonAddress(
    aggregates: Aggregates["Service"],
    locked: Locked<"Person">,
    address: string
  ) {
    yield* InTransaction;

    const rows = yield* aggregates
      .remove(locked, personClaims, eq(companyAddress.address, address))
      .pipe(Effect.orDie);

    if (rows.length !== 1) {
      return yield* Effect.die(
        "the person's previous company address claim is missing"
      );
    }

    return yield* Effect.void;
  }
);

export const claimTeamAddress = Effect.fn("CompanyAddress.claimTeam")(
  function* claimTeamAddress(
    db: Drizzle["Service"],
    teamId: number,
    address: string
  ) {
    yield* InTransaction;

    const rows = yield* db
      .insert(companyAddress)
      .values({ address, personId: null, teamId })
      .onConflictDoNothing()
      .returning({ address: companyAddress.address })
      .pipe(Effect.orDie);

    return rows.length === 1
      ? yield* Effect.void
      : yield* addressConflict("Team", teamId);
  }
);

export const releaseTeamAddress = Effect.fn("CompanyAddress.releaseTeam")(
  function* releaseTeamAddress(
    db: Drizzle["Service"],
    teamId: number,
    address: string
  ) {
    yield* InTransaction;

    const rows = yield* db
      .delete(companyAddress)
      .where(
        and(
          eq(companyAddress.teamId, teamId),
          eq(companyAddress.address, address)
        )
      )
      .returning({ address: companyAddress.address })
      .pipe(Effect.orDie);

    if (rows.length !== 1) {
      return yield* Effect.die(
        "the team's previous company address claim is missing"
      );
    }

    return yield* Effect.void;
  }
);
