/**
 * A retention rule's row, arranged for a test (spec 0007b, falsifier 2 and R4): the rows that its builder makes, in a world
 * of its own, and the two instants that the table-driven checks use, one second inside the period and one second outside
 * it. The check of a run that changes rows and the check of a report arrange the rule the same way.
 */
import { afterDuration, ruleId } from "@vektorprogrammet/domain";
import type { RetentionRule } from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option, Record as Rec } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import { FAR_AHEAD, builders, createdAt } from "./retentionBuilders.ts";
import type { Builder } from "./retentionBuilders.ts";
import { world } from "./teamsWorld.ts";

/** What a check of a rule is given: the rows that the rule's builder made, and the instants around the end of its period. */
export interface Arranged {
  readonly built: Effect.Success<ReturnType<Builder>>;
  readonly inside: DateTime.Utc;
  readonly outside: DateTime.Utc;
}

const arrange = Effect.fnUntraced(function* arrange(
  rule: RetentionRule,
  builder: Builder,
  tag: string
) {
  const arranged = yield* world(tag).pipe(Effect.orDie);
  // The world's own person is created far ahead, so that the person core's rule never expires it in the middle of a check.
  yield* createdAt(arranged.person.id, FAR_AHEAD);

  const built = yield* builder({
    personId: arranged.person.id,
    positionId: arranged.memberPosition,
    tag,
    teamId: arranged.team.id,
  });

  const expiry = afterDuration(built.start, rule.retention.period.duration);

  return {
    built,
    inside: DateTime.subtract(expiry, { seconds: 1 }),
    outside: DateTime.add(expiry, { seconds: 1 }),
  } satisfies Arranged;
});

/**
 * The problems that `check` finds for one rule, in a world of its own: `check` is given the rule's name and its
 * arrangement, and a rule without a builder is a problem of its own. The caller rolls the transaction back.
 */
export const checkRule = <E, R>(
  rule: RetentionRule,
  tag: string,
  check: (
    name: string,
    arranged: Arranged
  ) => Effect.Effect<string[], E, R | SqlClient>
) => {
  const name = ruleId(rule);

  const found = Arr.findFirst(Rec.toEntries(builders), ([id]) => id === name);

  return Option.match(found, {
    onNone: () => Effect.succeed([`${name} has no builder`]),
    onSome: ([, builder]) =>
      Effect.flatMap(arrange(rule, builder, tag), (arranged) =>
        check(name, arranged)
      ),
  });
};
