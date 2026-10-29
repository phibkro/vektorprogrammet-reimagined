/**
 * Spec 0022 F4: the catalog's `OutboxMessage` is the union that the library held before the split (ADR 0015 stage 3). The
 * rows that `packages/db` persists decode with it, the `outbox.kind` check lists its tags, and the queue consumer
 * matches on them, so its tags, their order and the encoded shape of each are pinned to main `c0ab784`, where
 * `shared/outbox.ts` declared them in one `Schema.TaggedUnion`. `outboxMessage.golden.json` is that union's tags and
 * its `SchemaRepresentation` as JSON, written by a script run on that commit.
 */
import { assert, describe, it } from "@effect/vitest";
import { Record as Rec, Schema, SchemaRepresentation } from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  EmailAddress,
  IssueCodeMessage,
  OutboxMessage,
  SetCredentialMessage,
  SlackPostMessage,
  SlackTarget,
  WorkspaceChangeMessage,
  declareMessage,
  isListed,
} from "../../src/index.ts";
import type { DeclaredMessage, EmailMessage } from "../../src/index.ts";
import golden from "./outboxMessage.golden.json" with { type: "json" };

const representationOf = (union: Schema.Top) =>
  SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(union.ast));

describe("spec 0022 F4: the catalog is the union of before", () => {
  it("has the tags of main, in the order that the outbox.kind check lists them", () => {
    assert.deepStrictEqual(Rec.keys(OutboxMessage.cases), golden.cases);
  });

  it("has the encoded shape of main for every case", () => {
    assert.deepStrictEqual(
      representationOf(OutboxMessage),
      golden.representation
    );
  });

  it("control: a union with one field renamed does not have it", () => {
    const renamed = Schema.Union([
      declareMessage("Email", {
        recipient: EmailAddress,
        replyTo: Schema.NullOr(EmailAddress),
        subject: Schema.String,
        text: Schema.String,
      }),
      IssueCodeMessage,
      SetCredentialMessage,
      SlackPostMessage,
      WorkspaceChangeMessage,
    ]);

    assert.notStrictEqual(
      JSON.stringify(representationOf(renamed)),
      JSON.stringify(golden.representation)
    );
  });
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
