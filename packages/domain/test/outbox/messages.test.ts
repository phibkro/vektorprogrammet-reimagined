/** Provider lifecycle intents are persisted in the same catalog as other outbox messages. */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  DeleteAuthUserMessage,
  RelinkAuthUserMessage,
  PersonId,
  SlackPostMessage,
  SlackTarget,
  declareMessage,
  isListed,
  OutboxMessage,
} from "../../src/index.ts";
import type { DeclaredMessage, EmailMessage } from "../../src/index.ts";

describe("provider lifecycle intents", () => {
  it.effect("round trips deletion and relink without credentials", () =>
    Effect.gen(function* lifecycleRoundTrip() {
      const deletion = DeleteAuthUserMessage.make({
        userId: "00000000-0000-4000-8000-000000000001",
      });

      const relink = RelinkAuthUserMessage.make({
        from: PersonId.make(1),
        into: PersonId.make(2),
        userId: deletion.userId,
      });

      const encodedDeletion =
        yield* Schema.encodeEffect(OutboxMessage)(deletion);

      const encodedRelink = yield* Schema.encodeEffect(OutboxMessage)(relink);
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(OutboxMessage)(encodedDeletion),
        deletion
      );
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(OutboxMessage)(encodedRelink),
        relink
      );
      assert.deepStrictEqual(encodedDeletion, {
        _tag: "DeleteAuthUser",
        userId: deletion.userId,
      });
    })
  );
});

describe("spec 0022 R3 and R5: only a declared message can be enqueued, and the catalog says which are listed", () => {
  it("a message built from a declaration is a declared message; a literal with the same tag is not", () => {
    type IsDeclared<M> = M extends DeclaredMessage ? true : false;

    expectTypeOf<IsDeclared<typeof EmailMessage.Type>>().toEqualTypeOf<true>();
    expectTypeOf<
      IsDeclared<{ readonly _tag: "Email"; readonly to: string }>
    >().toEqualTypeOf<false>();
  });

  it("the catalog lists a message that a service declared, and not one that nobody listed", () => {
    const unlisted = declareMessage("Unlisted", {});

    assert.isTrue(
      isListed(
        SlackPostMessage.make({
          target: SlackTarget.cases.Notifications.make({}),
          text: "hei",
        })
      )
    );
    assert.isFalse(isListed(unlisted.make({})));
  });
});
