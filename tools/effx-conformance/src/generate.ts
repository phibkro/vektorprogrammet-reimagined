/**
 * The derived half of the artefacts: the description of each domain that effx can be given, and the register of what it
 * cannot. Both are pure functions of the kernel's declarations; `regenerate` hands the descriptions to effx, and the
 * test compares what is committed with what this returns.
 */
import { Declarations, Effx } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Schema } from "effect";

const GapRegister = Schema.Array(Effx.Gap);

export interface Derived {
  /** The text of the register of gaps: the kernel's own, then those of each domain in the order of the documents. */
  readonly gaps: string;
  /** The committed text of the description of each domain that has one, with its domain and its description. */
  readonly descriptions: readonly {
    readonly description: Effx.EffxDescription;
    readonly domain: string;
    readonly text: string;
  }[];
}

export const derive = Effect.fn("derive")(function* derive() {
  const exported = Arr.map(Declarations, (declaration) => ({
    domain: declaration.name,
    ...Effx.describe(declaration),
  }));

  const gaps = yield* Schema.encodeUnknownEffect(GapRegister)([
    ...Effx.kernelGaps,
    ...Arr.flatMap(exported, (found) => found.gaps),
  ]);

  return {
    descriptions: Arr.flatMap(exported, ({ description, domain }) =>
      Option.match(description, {
        onNone: () => [],
        onSome: (found) => [
          { description: found, domain, text: Effx.committedJson(found) },
        ],
      })
    ),
    gaps: Effx.committedJson(gaps),
  } satisfies Derived;
});
