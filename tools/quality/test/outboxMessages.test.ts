/**
 * Spec 0022 F5: every message that is declared is listed in the catalog, and every listed message is declared. A message
 * is declared with `declareMessage("Tag", …)` (`shared/outbox.ts` for the two transport messages, the owning service
 * for the others) and the catalog (`outbox/messages.ts`) lists them in one union that the PostgreSQL adapter encodes
 * with. A declared message that the union lacks would be a defect at its first enqueue, in production, so this reads the
 * sources and says so at test time.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { OutboxMessage } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Order, Record as Rec } from "effect";

import { scanImports } from "../moduleGraphCheck.ts";
import type { SourceFile } from "../resolveImports.ts";
import { d, parsed } from "./support/moduleGraphFixture.ts";

const root = new URL("../../../", import.meta.url).pathname;

const declaration = /\bdeclareMessage\(\s*"(?<tag>[A-Za-z]+)"/gu;

/** The tags that the domain's sources declare, sorted. */
const declaredTags = (files: readonly SourceFile[]): readonly string[] =>
  Arr.sort(
    Arr.flatMap(
      Arr.filter(files, (file) => file.path.startsWith(`${d}/`)),
      (file: SourceFile) =>
        Arr.map(
          [...file.text.matchAll(declaration)],
          (found) => found.groups?.tag ?? ""
        )
    ),
    Order.String
  );

const listedTags = Arr.sort(Rec.keys(OutboxMessage.cases), Order.String);

describe("spec 0022 F5: the catalog lists the messages that are declared", () => {
  it("control: a declared message that the union lacks, and a listed one that nobody declares, each differ", () => {
    const withExtra = declaredTags([
      parsed(
        `${d}/accounts/messages.ts`,
        'export const A = declareMessage("IssueCode", {});'
      ),
      parsed(
        `${d}/teams/messages.ts`,
        'export const B = declareMessage("WelcomeSlack", {});'
      ),
    ]);

    assert.deepStrictEqual(withExtra, ["IssueCode", "WelcomeSlack"]);
    assert.notStrictEqual(
      JSON.stringify(withExtra),
      JSON.stringify(listedTags)
    );
    assert.notStrictEqual(
      JSON.stringify(declaredTags([])),
      JSON.stringify(listedTags)
    );
  });

  it.effect(
    "the real tree declares exactly the messages that the union lists",
    () =>
      Effect.gen(function* realTree() {
        assert.deepStrictEqual(
          declaredTags(yield* scanImports(root)),
          listedTags
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
