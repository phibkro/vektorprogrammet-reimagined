/**
 * The generated blocks of `docs/system/impact.md` (spec 0027 D10): the measures with their definitions, the grains and
 * their audiences, the minimum with its approval, and how the cells of a lattice relate. Pure, like the other renderers:
 * the declarations go in, the page comes out, and the check compares it with the committed one.
 */
import { ImpactMeasures } from "@vektorprogrammet/domain";
import type { Result } from "effect";
import { Array as Arr } from "effect";

import { checkRendered, replaceBlocks, table } from "./render.ts";

/** What the page is made of: the real declarations, or changed ones in the tests that show a changed declaration changes it. */
export interface ImpactDeclarations {
  readonly measures: readonly ImpactMeasures.MeasureDeclaration[];
  readonly minimum: typeof ImpactMeasures.Minimum;
  readonly unavailable: string;
}

const IMPACT: ImpactDeclarations = {
  measures: ImpactMeasures.Measures,
  minimum: ImpactMeasures.Minimum,
  unavailable: ImpactMeasures.NO_SOURCE_REASON,
};

const partsWords = (parts: ImpactMeasures.Parts): string =>
  parts === "add"
    ? "The total is the sum of the parts."
    : "The total is at least the largest part and at most the sum of the parts.";

const measuresBlock = (declared: ImpactDeclarations): string =>
  table(
    [
      "Measure",
      "Definition (English)",
      "Definisjon (norsk)",
      "Parts",
      "Grains",
    ],
    Arr.map(declared.measures, (measure) => [
      `\`${measure.id}\`: ${measure.name.en}`,
      measure.definition.en,
      measure.definition.no,
      partsWords(measure.parts),
      Arr.join(
        Arr.map(
          measure.grains,
          (grain) => `${grain} (${ImpactMeasures.audienceOf(grain)})`
        ),
        ", "
      ),
    ])
  );

const rulesBlock = (declared: ImpactDeclarations): string =>
  table(
    ["Rule", "Value"],
    [
      [
        "Minimum: a count from 1 to the minimum less one is suppressed",
        `${declared.minimum.value} (${declared.minimum.approval}: awaiting operator approval)`,
      ],
      [
        "What a hidden cell says",
        `${ImpactMeasures.HIDDEN.en}: ${ImpactMeasures.hiddenNote(declared.minimum.value).en}`,
      ],
      [
        "The reason of a cell that no source answers",
        `\`${declared.unavailable}\``,
      ],
    ]
  );

export const renderImpactDocument = (
  document: string,
  declared: ImpactDeclarations = IMPACT
): Result.Result<string, string> =>
  replaceBlocks(document, [
    ["measures", measuresBlock(declared)],
    ["rules", rulesBlock(declared)],
  ]);

export const checkImpactDocument = (
  document: string,
  declared: ImpactDeclarations = IMPACT
): Result.Result<void, string> =>
  checkRendered(document, renderImpactDocument(document, declared));
