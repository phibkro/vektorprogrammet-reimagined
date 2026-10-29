/**
 * Code persistence. A code belongs to its subject (spec 0006b): a write takes the subject's `Locked` token. Its life is
 * `CodeMachine` (spec 0024): `issue` stores a code `Unsent`, and the other two writes are transitions applied with
 * `UPDATE … WHERE state = ANY(from)` (`Aggregates.apply`), so each has one winner. Only a `Usable` code is read.
 */
import {
  CodeHash,
  CodePurpose,
  CodeRepository,
  CodeState,
  PersonId,
  codePolicy,
  codeTransition,
} from "@vektorprogrammet/domain";
import type { Code, CodeStep, Locked } from "@vektorprogrammet/domain";
import { and, eq, gt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { verified } from "../live.ts";
import { code } from "../schema.ts";

const StoredCode = Schema.Struct({
  expiresAt: Schema.DateTimeUtcFromDate,
  hash: CodeHash,
  purpose: CodePurpose,
  state: Schema.Literals(["Unsent", "Usable", "Used"]),
  subject: PersonId,
});

const decodeCode = decodeWith(StoredCode);

const states = {
  Unsent: CodeState.cases.Unsent.make({}),
  Usable: CodeState.cases.Usable.make({}),
  Used: CodeState.cases.Used.make({}),
} as const;

const codeOf = (row: typeof StoredCode.Type): Code => ({
  expiresAt: row.expiresAt,
  hash: row.hash,
  purpose: row.purpose,
  state: states[row.state],
  subject: row.subject,
});

const { owned } = roots.Person;

const CHANGED = "Koden kan ikke brukes. Prøv igjen.";

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
              eq(code.state, "Usable"),
              gt(code.expiresAt, DateTime.toDateUtc(request.now))
            )
          )
          .pipe(Effect.orDie);

        return Option.map(yield* decodeFirstOption(decodeCode)(rows), codeOf);
      }
    );

    const issue = Effect.fn("CodeRepository.issue")(function* issue(
      locked: Locked<"Person">,
      value: Pick<Code, "expiresAt" | "hash" | "purpose">
    ) {
      // The older code of this purpose goes in whatever state it is in: the new one replaces it (RULE-220), and it is
      // the new row's state, not the old one's, that decides what authenticates.
      yield* aggregates.remove(
        locked,
        owned.code,
        eq(code.purpose, value.purpose)
      );

      yield* aggregates.insert(locked, owned.code, {
        expiresAt: DateTime.toDateUtc(value.expiresAt),
        hash: value.hash,
        purpose: value.purpose,
        state: "Unsent",
      });
    }, Effect.orDie);

    /** One transition of `CodeMachine` on the code with this hash; `false` when no row matched (a `Conflict`, nothing written). */
    const applied = (
      locked: Locked<"Person">,
      step: CodeStep,
      where: SQL | undefined
    ) =>
      aggregates
        .apply(codeTransition(step), locked, {
          entity: "Account",
          key: String(locked.id),
          message: CHANGED,
          owned: owned.code,
          where,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            Conflict: () => Effect.succeed(false),
            EffectDrizzleQueryError: Effect.die,
          })
        );

    const acknowledge = Effect.fn("CodeRepository.acknowledge")(
      function* acknowledge(
        locked: Locked<"Person">,
        request: Parameters<CodeRepository["Service"]["acknowledge"]>[1]
      ) {
        return yield* applied(
          locked,
          "acknowledgeCode",
          and(eq(code.hash, request.hash), eq(code.purpose, request.purpose))
        );
      }
    );

    const consume = Effect.fn("CodeRepository.consume")(function* consume(
      locked: Locked<"Person">,
      request: Parameters<CodeRepository["Service"]["consume"]>[1]
    ) {
      return yield* applied(
        locked,
        // The single-use purposes name their command (`codePolicy`), which is the transition's name.
        codePolicy[request.purpose].command,
        and(
          eq(code.hash, request.hash),
          eq(code.purpose, request.purpose),
          gt(code.expiresAt, DateTime.toDateUtc(request.now))
        )
      );
    });

    return yield* verified(
      "CodeRepository",
      CodeRepository.of({ acknowledge, consume, findUsable, issue })
    );
  })
);
