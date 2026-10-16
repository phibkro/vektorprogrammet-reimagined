/**
 * C8 social events (RULE-188 validation, RULE-085 badges). Fixed legacy
 * defects: the end must be after the start, and the never-enforced
 * "which users may sign up" role field is not part of the model.
 */
import type { DateTime } from "effect";
import { Schema } from "effect";

import { addOsloCalendar, isBefore } from "../shared/clock.ts";
import { DepartmentId, SemesterId, SocialEventId } from "../shared/ids.ts";
import { REQUIRED_FIELD_MESSAGE, requiredText } from "../shared/validation.ts";

const eventFields = {
  departmentId: DepartmentId,
  description: Schema.String.check(Schema.isMaxLength(5000)),
  endsAt: Schema.DateTimeUtc,
  link: Schema.NullOr(Schema.String.check(Schema.isMaxLength(250))),
  semesterId: SemesterId,
  startsAt: Schema.DateTimeUtc,
  title: Schema.String.check(Schema.isNonEmpty()),
};

export const SocialEvent = Schema.Struct({ id: SocialEventId, ...eventFields });

export type SocialEvent = typeof SocialEvent.Type;

export const SocialEventDraft = Schema.Struct(eventFields);

export type SocialEventDraft = typeof SocialEventDraft.Type;

export const END_BEFORE_START_MESSAGE =
  "Sluttidspunktet må være etter starttidspunktet.";

/** RULE-188: title required, link at most 250 characters, end after start. */
export const SocialEventInput = Schema.Struct({
  departmentId: DepartmentId,
  description: Schema.String.check(
    Schema.isMaxLength(5000, { message: "Maks 5000 tegn." })
  ),
  endsAt: Schema.DateTimeUtcFromString,
  link: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(250, { message: "Maks 250 tegn." }))
  ),
  semesterId: SemesterId,
  startsAt: Schema.DateTimeUtcFromString,
  title: requiredText({ maxLength: 255 }).annotateKey({
    messageMissingKey: REQUIRED_FIELD_MESSAGE,
  }),
}).check(
  Schema.makeFilter((event) =>
    isBefore(event.startsAt, event.endsAt)
      ? true
      : { issue: END_BEFORE_START_MESSAGE, path: ["endsAt"] }
  )
);

export type SocialEventInput = typeof SocialEventInput.Type;

export type EventBadge = "HasHappened" | "WithinAWeek" | "None";

export const EVENT_BADGE_LABEL: Record<EventBadge, string | null> = {
  HasHappened: "Har vært",
  None: null,
  WithinAWeek: "Skjer innen en uke",
};

/**
 * RULE-085: started before now → "Har vært"; otherwise starting within one
 * week (Oslo calendar) → "Skjer innen en uke"; else no badge.
 */
export const eventBadge = (
  event: Pick<SocialEvent, "startsAt">,
  now: DateTime.DateTime
): EventBadge => {
  if (isBefore(event.startsAt, now)) {
    return "HasHappened";
  }

  if (isBefore(event.startsAt, addOsloCalendar(now, { weeks: 1 }))) {
    return "WithinAWeek";
  }

  return "None";
};
