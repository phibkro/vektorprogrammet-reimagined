/** Read-only session projection: last seen is derived from the latest audited command. */
import type { PersonId as PersonIdValue } from "@vektorprogrammet/domain";
import { and, eq, gt, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { auditLog, authSession, authUser } from "../schema.ts";

const StoredSession = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromDate,
  id: Schema.NonEmptyString,
  lastSeen: Schema.DateTimeUtcFromDate,
  userAgent: Schema.NullOr(Schema.String),
});

export type SessionActivity = typeof StoredSession.Type;

export class SessionDirectory extends Context.Service<
  SessionDirectory,
  {
    readonly byPerson: (
      personId: PersonIdValue,
      now: DateTime.Utc
    ) => Effect.Effect<readonly SessionActivity[]>;
  }
>()("@vektorprogrammet/db/SessionDirectory") {}

export const SessionDirectoryLive = Layer.effect(
  SessionDirectory,
  Effect.gen(function* SessionDirectoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Schema.Array(StoredSession));

    const byPerson = Effect.fn("SessionDirectory.byPerson")(function* byPerson(
      personId: PersonIdValue,
      now: DateTime.Utc
    ) {
      const rows = yield* db
        .select({
          createdAt: authSession.createdAt,
          id: authSession.id,
          lastSeen: sql`greatest(${authSession.createdAt}, coalesce((
            select max(${auditLog.at}) from ${auditLog}
            where ${auditLog.sessionId} = ${authSession.id}
          ), ${authSession.createdAt}))`,
          userAgent: authSession.userAgent,
        })
        .from(authSession)
        .innerJoin(authUser, eq(authUser.id, authSession.userId))
        .where(
          and(
            eq(authUser.personId, personId),
            gt(authSession.expiresAt, DateTime.toDateUtc(now))
          )
        )
        .orderBy(authSession.createdAt)
        .pipe(Effect.orDie);

      return yield* decode(rows);
    });

    return SessionDirectory.of({ byPerson });
  })
);
