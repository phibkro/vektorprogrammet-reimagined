/** Read-only session projection: last seen is derived from the latest audited command. */
import { Context, Schema } from "effect";
import type { DateTime, Effect } from "effect";

import type { PersonId } from "../shared/ids.ts";

/** One signed-in session of a person, as Min side shows it. */
export const SessionActivity = Schema.Struct({
  createdAt: Schema.DateTimeUtc,
  id: Schema.NonEmptyString,
  lastSeen: Schema.DateTimeUtc,
  userAgent: Schema.NullOr(Schema.String),
});

export type SessionActivity = typeof SessionActivity.Type;

export class SessionDirectory extends Context.Service<
  SessionDirectory,
  {
    readonly byPerson: (
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect.Effect<readonly SessionActivity[]>;
  }
>()("@vektorprogrammet/domain/accounts/SessionDirectory") {}
