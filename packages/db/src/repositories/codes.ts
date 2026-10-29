/**
 * Single-use code persistence. A code belongs to its subject (spec 0006b): a write takes the subject's `Locked` token,
 * and every use is a conditional update with one winner.
 */
import {
  CodeHash,
  CodePurpose,
  CodeRepository,
  PersonId,
} from "@vektorprogrammet/domain";
import type { Code, Locked } from "@vektorprogrammet/domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { verified } from "../live.ts";
import { code } from "../schema.ts";

const StoredCode = Schema.Struct({
  expiresAt: Schema.DateTimeUtcFromDate,
  hash: CodeHash,
  purpose: CodePurpose,
  subject: PersonId,
  usedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
});

const decodeCode = decodeWith(StoredCode);

export const CodeRepositoryLive = Layer.effect(
  CodeRepository,
  Effect.gen(function* CodeRepositoryLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;

    const findUsable = Effect.fn("CodeRepository.findUsable")(
      function* findUsable(
        request: Parameters<CodeRepository["Service"]["findUsable"]>[0]
      ) {
        const rows = yield* db
          .select()
          .from(code)
          .where(
            and(
              eq(code.hash, request.hash),
              eq(code.purpose, request.purpose),
              isNull(code.usedAt),
              gt(code.expiresAt, DateTime.toDateUtc(request.now))
            )
          )
          .pipe(Effect.orDie);

        return yield* decodeFirstOption(decodeCode)(rows);
      }
    );

    const replace = Effect.fn("CodeRepository.replace")(function* replace(
      locked: Locked<"Person">,
      value: Pick<Code, "expiresAt" | "hash" | "purpose">
    ) {
      const expiresAt = DateTime.toDateUtc(value.expiresAt);

      yield* aggregates
        .insert(
          locked,
          roots.Person.owned.code,
          { expiresAt, hash: value.hash, purpose: value.purpose, usedAt: null },
          {
            action: "replace",
            set: { expiresAt, hash: value.hash, usedAt: null },
            target: [code.purpose, code.subject],
          }
        )
        .pipe(Effect.orDie);
    });

    const consume = Effect.fn("CodeRepository.consume")(function* consume(
      locked: Locked<"Person">,
      request: Parameters<CodeRepository["Service"]["consume"]>[1]
    ) {
      const now = DateTime.toDateUtc(request.now);

      const rows = yield* aggregates
        .update(locked, roots.Person.owned.code, {
          set: { usedAt: now },
          where: and(
            eq(code.hash, request.hash),
            eq(code.purpose, request.purpose),
            isNull(code.usedAt),
            gt(code.expiresAt, now)
          ),
        })
        .pipe(Effect.orDie);

      return rows.length === 1;
    });

    return yield* verified(
      "CodeRepository",
      CodeRepository.of({ consume, findUsable, replace })
    );
  })
);
