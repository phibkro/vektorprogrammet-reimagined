/**
 * C8 social events (RULE-188). The news, static texts and sponsors of the public site are the CMS's (spec 0005),
 * so this is the only content repository left.
 */
import { SocialEvent, SocialEventRepository } from "@vektorprogrammet/domain";
import type {
  DepartmentId,
  SemesterId,
  SocialEventDraft,
} from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import { Drizzle, decodeWith, single } from "../internal/drizzle.ts";
import { socialEvent } from "../schema.ts";

/** A social event row as stored: the window bounds are `Date`s from the driver. */
const SocialEventRow = Schema.Struct({
  ...SocialEvent.fields,
  endsAt: Schema.DateTimeUtcFromDate,
  startsAt: Schema.DateTimeUtcFromDate,
});

const socialEventColumns = {
  departmentId: socialEvent.departmentId,
  description: socialEvent.description,
  endsAt: socialEvent.endsAt,
  id: socialEvent.id,
  link: socialEvent.link,
  semesterId: socialEvent.semesterId,
  startsAt: socialEvent.startsAt,
  title: socialEvent.title,
};

export const SocialEventRepositoryLive = Layer.effect(
  SocialEventRepository,
  Effect.gen(function* SocialEventRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(SocialEventRow);
    const decodeAll = decodeWith(Schema.Array(SocialEventRow));

    const list = Effect.fn("SocialEventRepository.list")(
      function* list(filter: {
        readonly departmentId: DepartmentId;
        readonly semesterId: SemesterId;
      }) {
        const rows = yield* db
          .select(socialEventColumns)
          .from(socialEvent)
          .where(
            and(
              eq(socialEvent.departmentId, filter.departmentId),
              eq(socialEvent.semesterId, filter.semesterId)
            )
          )
          .pipe(Effect.orDie);

        return yield* decodeAll(rows);
      }
    );

    const create = Effect.fn("SocialEventRepository.create")(function* create(
      draft: SocialEventDraft
    ) {
      const rows = yield* db
        .insert(socialEvent)
        .values({
          ...draft,
          endsAt: DateTime.toDateUtc(draft.endsAt),
          startsAt: DateTime.toDateUtc(draft.startsAt),
        })
        .returning(socialEventColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    return SocialEventRepository.of({ create, list });
  })
);
