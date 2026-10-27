/**
 * Spec 0007b R3 item 28: a period that a declared text states is built from the declaration of the period, so it follows
 * it. An approval or a new decision changes one line of `periods.ts` (or a code's lifetime in `codePolicy`), and every
 * reason, purpose and command text that says how long something is kept or how long a code lives must change with it:
 * otherwise "each period is one declaration" is not true, and two generated documents can disagree.
 *
 * A scan for "30 days" cannot tell a built phrase from a written one (three periods are 30 days today), so the test
 * moves the values instead. It evaluates the whole domain a second time with every period and every code lifetime
 * replaced, takes every string that a declaration holds in both evaluations, and fails on any period phrase of the real
 * evaluation that is still in the same place of the other: a phrase that did not move was written, not built. The consent
 * texts are the one exception. A consent text is what a person agrees to, and a record names its version, so its words
 * must not change under a period by themselves: it is written out, and the last tests fail when a period that it states
 * is not the declared one, which is the reminder to write the next version of the text.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Effect,
  Option,
  Order,
  Record as Rec,
  Schema,
  String as Str,
} from "effect";
import { vi } from "vite-plus/test";

import * as RealCode from "../../src/accounts/code.ts";
import * as Real from "../../src/index.ts";
import * as RealCommands from "../../src/kernel/commands.ts";

/** The strings of each group of declarations, in the order they stand: the same order in every evaluation of the domain. */
type Declared = Readonly<Record<string, readonly string[]>>;

// ------------------------------------------------------------------ the phrases

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "en",
  "ett",
  "to",
  "tre",
  "fire",
  "fem",
  "seks",
  "sju",
  "syv",
  "åtte",
  "ni",
  "ti",
  "elleve",
  "tolv",
];

const UNITS = [
  "days?",
  "weeks?",
  "months?",
  "years?",
  "dag(?:er)?",
  "uke(?:r)?",
  "måned(?:er)?",
  "år",
];

/** A number (digits or a word) and a unit of time, not part of a longer number or word: "30 days", "three years", "5 år". */
const PHRASE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:\\d+|${Arr.join(NUMBER_WORDS, "|")})\\s+(?:${Arr.join(UNITS, "|")})(?![\\p{L}\\p{N}])`,
  "giu"
);

/** The period phrases of a text, in lower case, in the order they stand. */
const phrasesIn = (text: string): readonly string[] =>
  Arr.map(Arr.fromIterable(Str.matchAll(PHRASE)(text)), ([phrase]) =>
    phrase.toLowerCase()
  );

/**
 * The period phrases of `real` that `moved` still has in the same place: a phrase that survives a change of every period
 * was written, not built. A text that `exempt` names is written on purpose.
 */
const writtenPhrases = (
  real: Declared,
  moved: Declared,
  exempt: (group: string, text: string) => boolean
): readonly string[] =>
  Arr.flatMap(Rec.toEntries(real), ([group, texts]) =>
    Arr.flatMap(texts, (text, index) =>
      exempt(group, text)
        ? []
        : Arr.map(
            Arr.filter(phrasesIn(text), (phrase) =>
              Arr.contains(phrasesIn(moved[group]?.[index] ?? ""), phrase)
            ),
            (phrase) => `${group}[${index}] "${phrase}" in: ${text}`
          )
    )
  );

const NOTHING_IS_EXEMPT = (): boolean => false;

// ------------------------------------------------------------------ the declared strings

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The strings of a JSON text, in the order they stand, keys included (a key states no period). */
const stringsOf = (json: string): readonly string[] =>
  Arr.map(
    Arr.fromIterable(Str.matchAll(/"(?<text>(?:[^"\\]|\\.)*)"/gu)(json)),
    (match) => match.groups?.text ?? ""
  );

/**
 * What the personal data declarations and the commands say, in one evaluation of the domain: the catalog, the forms, the
 * texts, and what every domain says of its commands and reads (the words that `docgen` prints).
 */
const declaredStrings = Effect.fnUntraced(function* declaredStrings(
  domain: typeof Real,
  commands: typeof RealCommands
) {
  const groups = {
    approvalWords: domain.approvalWords,
    catalog: domain.Catalog,
    consentNames: domain.consentNames,
    consentTexts: domain.consentTexts,
    domains: Arr.map(domain.Declarations, (declared) => ({
      commands: Arr.map(declared.commands, (rpc) => ({
        info: Option.getOrNull(commands.infoOf(rpc)),
        name: rpc._tag,
      })),
      name: declared.name,
      reads: declared.reads,
      title: declared.title,
    })),
    forms: domain.Forms,
    legalBases: domain.legalBases,
    privacyText: domain.privacyText,
    purposes: domain.purposes,
  };

  const encoded = yield* Effect.forEach(
    Rec.toEntries(groups),
    ([group, value]) =>
      Effect.map(encodeJson(value), (json) => [group, stringsOf(json)] as const)
  );

  const declared: Declared = Rec.fromEntries(encoded);

  return declared;
});

/**
 * The texts that are written out on purpose. A consent text (see the header); and the summary of `sendEndingSoon`, which
 * says "four weeks" for `ENDING_SOON_WEEKS` (spec 0006): the window of a job in the teams slice, not a retention period.
 * It could be built, and a change of the constant would leave it behind; it is left, because changing the teams
 * declaration reopens the confirmation of the membership model for a doc string (spec 0007b R3 item 28 says so).
 */
const isWrittenOnPurpose = (group: string, text: string): boolean =>
  group === "consentTexts" ||
  text.startsWith("Four weeks before the semester ends");

// ------------------------------------------------------------------ the second evaluation

/** A count that no real period or lifetime has, and no real phrase is part of: 3 becomes 32, 30 becomes 221, 0 becomes 11. */
const SCALE = 7;
const OFFSET = 11;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The domain again, with every period and every code lifetime replaced (the units and the approvals stay). Two
 * evaluations of one module graph cannot be two static imports, so the second is made here, once, before the tests: the
 * modules are forgotten, the two modules that hold the values are replaced, and the domain is imported anew.
 */
vi.resetModules();

vi.doMock("../../src/personalData/periods.ts", () => ({
  Periods: Rec.map(Real.Periods, (period) => ({
    ...period,
    duration: {
      ...period.duration,
      count: period.duration.count * SCALE + OFFSET,
    },
  })),
}));

vi.doMock("../../src/accounts/code.ts", () => ({
  ...RealCode,
  codePolicy: Rec.map(RealCode.codePolicy, (policy) => ({
    ...policy,
    lifetimeSeconds: policy.lifetimeSeconds * SCALE + OFFSET * SECONDS_PER_DAY,
  })),
}));

const [Moved, MovedCommands] = await Promise.all([
  import("../../src/index.ts"),
  import("../../src/kernel/commands.ts"),
]);

// ------------------------------------------------------------------ the tests

/**
 * How many strings of each group state a period today. A new text that does so changes a count: it must be built, and
 * this is where that is noticed. The catalog's four are the reasons of `admin_grant`, `audit_log`, `membership` and
 * `outbox`; the domains' three are the summary of `setAlumniConsent`, the note of `answerAlumniConsent` and the summary
 * of `sendEndingSoon` (see `isWrittenOnPurpose`); the others are the alumni purpose and the keepDetails consent, each in
 * two languages.
 */
const EXPECTED_COUNTS = {
  catalog: 4,
  consentTexts: 2,
  domains: 3,
  purposes: 2,
};

describe("spec 0007b R3 item 28: a period that a declared text states is built from its declaration", () => {
  it.effect(
    "every period phrase in a declaration moves when every period and every code lifetime moves, except the consent texts",
    () =>
      Effect.gen(function* moves() {
        const real = yield* declaredStrings(Real, RealCommands);
        const domain = Moved;
        const moved = yield* declaredStrings(Moved, MovedCommands);

        // The harness sees what it should: the second evaluation has other periods and lifetimes, and the same strings.
        assert.notStrictEqual(
          domain.Periods.auditRows.duration.count,
          Real.Periods.auditRows.duration.count
        );

        assert.deepStrictEqual(
          Rec.map(moved, (texts) => texts.length),
          Rec.map(real, (texts) => texts.length)
        );

        assert.deepStrictEqual(
          writtenPhrases(real, moved, isWrittenOnPurpose),
          [],
          "a period is written in a text instead of built with durationWords / lifetimeWords from Periods / codePolicy"
        );

        // The inventory: the texts that state a period today, and none is a surprise.
        assert.deepStrictEqual(
          Rec.filter(
            Rec.map(
              real,
              (texts) =>
                Arr.filter(texts, (text) =>
                  Arr.isReadonlyArrayNonEmpty(phrasesIn(text))
                ).length
            ),
            (count) => count > 0
          ),
          EXPECTED_COUNTS
        );
      })
  );

  it.effect(
    "negative control: a text that writes its period is found, and a text that builds it is not",
    () =>
      Effect.sync(() => {
        // Three periods are 30 days: the written phrase stays, the built one becomes another number.
        assert.deepStrictEqual(
          writtenPhrases(
            { texts: ["kept 30 days", "kept 30 days"] },
            { texts: ["kept 221 days", "kept 30 days"] },
            NOTHING_IS_EXEMPT
          ),
          ['texts[1] "30 days" in: kept 30 days']
        );

        // A period in words, and in Norwegian, is a phrase too.
        assert.deepStrictEqual(
          writtenPhrases(
            { texts: ["kept three years", "lagres i 5 år"] },
            { texts: ["kept three years", "lagres i 5 år"] },
            NOTHING_IS_EXEMPT
          ),
          [
            'texts[0] "three years" in: kept three years',
            'texts[1] "5 år" in: lagres i 5 år',
          ]
        );

        // "1 year" is not a part of "11 years": a text that was built is not taken for one that was written.
        assert.deepStrictEqual(
          writtenPhrases(
            { texts: ["kept 1 year"] },
            { texts: ["kept 11 years"] },
            NOTHING_IS_EXEMPT
          ),
          []
        );

        // An exempt text is not looked at.
        assert.deepStrictEqual(
          writtenPhrases(
            { written: ["kept 30 days"] },
            { written: ["kept 30 days"] },
            (group) => group === "written"
          ),
          []
        );
      })
  );

  it("the keepDetails consent states the two periods that retention applies, in both languages and no other; the other consents state none", () => {
    for (const language of ["en", "no"] as const) {
      assert.deepStrictEqual(
        Arr.sort(
          phrasesIn(Real.consentTexts.keepDetails[language]),
          Order.String
        ),
        Arr.sort(
          [
            Real.durationWords(
              Real.Periods.personCoreWithKeepDetails.duration,
              language
            ),
            Real.durationWords(Real.Periods.personCore.duration, language),
          ],
          Order.String
        )
      );

      assert.deepStrictEqual(phrasesIn(Real.consentTexts.news[language]), []);
      assert.deepStrictEqual(phrasesIn(Real.consentTexts.photo[language]), []);
    }
  });

  it("negative control: when the periods move, the written consent text no longer states the declared ones (the reminder to write version 2)", () => {
    for (const language of ["en", "no"] as const) {
      assert.notDeepEqual(
        Arr.sort(
          phrasesIn(Real.consentTexts.keepDetails[language]),
          Order.String
        ),
        Arr.sort(
          [
            Moved.durationWords(
              Moved.Periods.personCoreWithKeepDetails.duration,
              language
            ),
            Moved.durationWords(Moved.Periods.personCore.duration, language),
          ],
          Order.String
        )
      );
    }
  });
});
