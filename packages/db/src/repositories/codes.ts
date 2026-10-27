/** Single-use code persistence; every use is a conditional update. */
import {
  CodeHash,
  CodePurpose,
  CodeRepository,
  PersonId,
} from "@vektorprogrammet/domain";
import type { Code } from "@vektorprogrammet/domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
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
      value: Code
    ) {
      yield* db
        .insert(code)
        .values({
          expiresAt: DateTime.toDateUtc(value.expiresAt),
          hash: value.hash,
          purpose: value.purpose,
          subject: value.subject,
          usedAt:
            value.usedAt === null ? null : DateTime.toDateUtc(value.usedAt),
        })
        .onConflictDoUpdate({
          set: {
            expiresAt: DateTime.toDateUtc(value.expiresAt),
            hash: value.hash,
            usedAt: null,
          },
          target: [code.purpose, code.subject],
        })
        .pipe(Effect.orDie);
    });

    const consume = Effect.fn("CodeRepository.consume")(function* consume(
      request: Parameters<CodeRepository["Service"]["consume"]>[0]
    ) {
      const rows = yield* db
        .update(code)
        .set({ usedAt: DateTime.toDateUtc(request.now) })
        .where(
          and(
            eq(code.hash, request.hash),
            eq(code.purpose, request.purpose),
            eq(code.subject, request.subject),
            isNull(code.usedAt),
            gt(code.expiresAt, DateTime.toDateUtc(request.now))
          )
        )
        .returning({ hash: code.hash })
        .pipe(Effect.orDie);

      return rows.length === 1;
    });

    return CodeRepository.of({ consume, findUsable, replace });
  })
);
