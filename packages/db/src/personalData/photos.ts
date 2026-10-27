/**
 * A person's photo is a public file that no one else uses (RULE-143). When the photo goes (cleared, anonymised with the
 * person, merged away), the file is retired with it, unless a person or a department still shows it. Retiring is a soft
 * delete: `findByKey` stops resolving the key, so `/filer/<key>` answers 404, and registering the same bytes again
 * brings the row back.
 */
import { and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Array as Arr, DateTime, Effect } from "effect";

import type { Drizzle } from "../internal/drizzle.ts";
import { department, person, publicFile } from "../schema.ts";

/** The photo keys of the people that a condition selects: read before the statement that clears them. */
export const photosOf = (
  db: Drizzle["Service"],
  where: SQL
): Effect.Effect<readonly string[]> =>
  db
    .select({ key: person.photoKey })
    .from(person)
    .where(and(where, isNotNull(person.photoKey)))
    .pipe(
      Effect.map((rows) =>
        Arr.flatMap(rows, ({ key }) => (key === null ? [] : [key]))
      ),
      Effect.orDie
    );

/** Retires the files of `keys` that nothing shows any more. */
export const releasePhotos = (
  db: Drizzle["Service"],
  keys: readonly string[],
  now: DateTime.Utc
): Effect.Effect<void> =>
  Arr.isReadonlyArrayNonEmpty(keys)
    ? db
        .update(publicFile)
        .set({ deletedAt: DateTime.toDateUtc(now) })
        .where(
          and(
            inArray(publicFile.key, keys),
            isNull(publicFile.deletedAt),
            sql`not exists (select 1 from ${person} where ${person.photoKey} = ${publicFile.key})`,
            sql`not exists (select 1 from ${department} where ${department.logoKey} = ${publicFile.key})`
          )
        )
        .pipe(Effect.orDie, Effect.asVoid)
    : Effect.void;
