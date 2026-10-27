/**
 * The renewal's command: `ExtendMembership` of the sibling spike's `Person` aggregate, sent through the real
 * `StaffingModel` on its PostgreSQL platform. Nothing here writes a table: the aggregate decides, and the platform
 * commits the event, the state, the receipt and the membership projection in one transaction.
 *
 * Guarantee of a send: when it returns, the event and the receipt are committed. The command id is derived from the
 * renewal (`extendCommandId`), so a second send of it (a retried task attempt, or a replay) finds the receipt and
 * returns the first answer: one decision, one event.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import { Effect, Layer } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  CommandFacts,
  RequestPrincipal,
} from "../../alchemy-domain/src/model/context.ts";
import { factsOf } from "../../alchemy-domain/src/model/facts.ts";
import { personKey } from "../../alchemy-domain/src/model/ids.ts";
import {
  StaffingModel,
  staffingProjections,
} from "../../alchemy-domain/src/model/model.ts";
import {
  ExtendMembership,
  Person,
} from "../../alchemy-domain/src/model/person.ts";
import { layer as postgresPlatform } from "../../alchemy-domain/src/postgresPlatform.ts";
import { PlatformTablesMissing } from "./errors.ts";
import { Extended, Refusal, extendCommandId } from "./renewal.ts";
import type { RenewalInput } from "./renewal.ts";
import { syntheticAdministrator } from "./testAuthority.ts";

/**
 * The model on the database that `url` names, for one task attempt: a Worker's Hyperdrive connection string is valid
 * for the invocation that read it, so every attempt builds its own small pool and closes it when the attempt ends.
 * The platform's tables are the test's to create (`migrate: false`), not a Worker's to create on first use.
 */
export const staffingLayer = (url: Redacted.Redacted) =>
  StaffingModel.layer(staffingProjections).pipe(
    Layer.provideMerge(postgresPlatform({ migrate: false })),
    Layer.provideMerge(DatabaseLive({ maxConnections: 2, url }))
  );

/** The Worker assumes nothing about the platform's tables: it checks, and fails loudly when they are not there. */
const requirePlatformTables = Effect.gen(function* requirePlatformTables() {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly present: boolean;
  }>`select to_regclass('alchemy_aggregate') is not null as present`;

  if (row?.present !== true) {
    return yield* Effect.die(
      new PlatformTablesMissing({
        message:
          "the Alchemy platform tables are missing: the test or admin setup must run migrate first",
        table: "alchemy_aggregate",
      })
    );
  }

  return yield* Effect.void;
});

/**
 * Sends `ExtendMembership` for `input` and reports what the platform answered. A refusal of the aggregate is returned
 * as `Refusal`, a decision that a retry would only repeat; anything else stays in the error channel.
 */
export const extendMembership = Effect.fn("renewal.extendMembership")(
  function* extendMembership(input: RenewalInput, attempt: number) {
    yield* requirePlatformTables;
    const people = yield* Person;
    const commandId = extendCommandId(input.renewalId);

    const facts = yield* factsOf("extendMembership", {
      membershipId: input.membershipId,
    });

    const sent = yield* people
      .send(
        personKey(input.personId),
        new ExtendMembership({
          end: input.end,
          membershipId: input.membershipId,
        }),
        { commandId }
      )
      .pipe(
        Effect.provideService(
          RequestPrincipal,
          syntheticAdministrator(input.actorId)
        ),
        Effect.provideService(CommandFacts, facts)
      );

    return Extended.make({ attempt, commandId, version: sent.version });
  },
  Effect.catchTag(
    ["AlreadyExists", "Conflict", "Forbidden", "NotFound", "ValidationFailed"],
    (refusal) => Effect.succeed(Refusal.make({ reason: refusal._tag }))
  )
);
