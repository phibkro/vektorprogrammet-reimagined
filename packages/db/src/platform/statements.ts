/**
 * Which constructs a SQL text uses (spec 0025, decision D6).
 *
 * A conservative token match, not a SQL parser: `sqlWords` removes comments and quoted text (strings, dollar-quoted
 * bodies, quoted identifiers), so that a word in a comment or in a message is not a construct; the detectors then read
 * what is left. A statement that a program builds from parts at run time is not seen, and neither is a construct that has
 * no tokens of its own (a conditional `UPDATE`). `pg-txmode`'s lint reads the PostgreSQL parser's own AST and replaces this
 * when that package is published and merged (spec 0025, Not done).
 *
 * Total and pure: the same text gives the same constructs, in the order of `PooledSafeConstructs` then
 * `DirectOnlyConstructs`.
 */
import { Array as Arr } from "effect";

import { DirectOnlyConstructs, PooledSafeConstructs } from "./constructs.ts";
import type { Construct, DirectOnlyConstruct } from "./constructs.ts";

/** The `$tag$` of a dollar quote that starts at `at`, if one does. */
const dollarTagAt = (text: string, at: number): string | undefined =>
  /^\$[A-Za-z_]*\$/u.exec(text.slice(at))?.[0];

/** The index after the next `mark` at or after `from`, or the end of the text when there is none. */
const endAfter = (text: string, mark: string, from: number): number => {
  const found = text.indexOf(mark, from);

  return found === -1 ? text.length : found + mark.length;
};

const endOfLine = (text: string, from: number): number => {
  const found = text.indexOf("\n", from);

  return found === -1 ? text.length : found;
};

/** The index after the string that starts after its opening quote at `from`: a doubled quote stays inside (and a backslash escapes in an `E'…'` string). */
const endOfString = (text: string, from: number, escapes: boolean): number => {
  let at = from;

  while (at < text.length) {
    const here = text.charAt(at);

    if (escapes && here === "\\") {
      at += 2;
    } else if (here === "'" && text.charAt(at + 1) === "'") {
      at += 2;
    } else if (here === "'") {
      return at + 1;
    } else {
      at += 1;
    }
  }

  return text.length;
};

/**
 * The comment, string or quoted name that starts at `at`: where it ends, and what stands in its place. A comment is a
 * space, a string `''`, a dollar-quoted body `$$` and a quoted identifier `"i"`. `undefined` when `at` starts none.
 */
const skipped = (
  text: string,
  at: number
): readonly [end: number, replacement: string] | undefined => {
  const here = text.charAt(at);
  const next = text.charAt(at + 1);

  if (here === "-" && next === "-") {
    return [endOfLine(text, at), " "];
  }

  if (here === "/" && next === "*") {
    return [endAfter(text, "*/", at + 2), " "];
  }

  if (here === "'") {
    return [endOfString(text, at + 1, /[eE]/u.test(text.charAt(at - 1))), "''"];
  }

  if (here === '"') {
    return [endAfter(text, '"', at + 1), '"i"'];
  }

  const tag = here === "$" ? dollarTagAt(text, at) : undefined;

  return tag === undefined
    ? undefined
    : [endAfter(text, tag, at + tag.length), "$$"];
};

/**
 * The text without comments and quoted text, in lower case, with runs of white space as one space: the places stay and
 * the words go.
 */
export const sqlWords = (text: string): string => {
  const out: string[] = [];
  let at = 0;

  while (at < text.length) {
    const found = skipped(text, at);

    if (found === undefined) {
      out.push(text.charAt(at));
      at += 1;
    } else {
      out.push(found[1]);
      [at] = found;
    }
  }

  return Arr.join(out, "").toLowerCase().replaceAll(/\s+/gu, " ");
};

/** At the start of the text or of a statement. */
const START = String.raw`(?:^|;)\s*`;

const WORDS_OF_A_LOCK = String.raw`(?:no\s+key\s+update|update|share|key\s+share)`;

/**
 * One detector for each construct that has tokens of its own. The constructs without one (`conditional-update-returning`,
 * `unnamed-statements`) are properties of how a statement is used or sent, and are shown by the probe instead.
 */
const detectors: readonly (readonly [Construct, RegExp])[] = [
  [
    "transaction-block",
    new RegExp(
      `${START}(?:begin|commit|rollback(?!\\s+to\\b)|start\\s+transaction)\\b`,
      "u"
    ),
  ],
  ["begin-isolation-level", /\bisolation\s+level\b/u],
  [
    "savepoint",
    new RegExp(`${START}(?:savepoint|release|rollback\\s+to)\\b`, "u"),
  ],
  ["row-lock", new RegExp(`\\bfor\\s+${WORDS_OF_A_LOCK}\\b`, "u")],
  ["row-lock-nowait", /\bnowait\b/u],
  ["row-lock-skip-locked", /\bskip\s+locked\b/u],
  ["on-conflict-returning", /\bon\s+conflict\b/u],
  ["unique-constraint", /\bunique\b/u],
  ["exclusion-constraint", /\bexclude\s+using\b/u],
  [
    "set-local",
    new RegExp(
      `${START}set\\s+local\\b|\\bset_config\\s*\\([^)]*,\\s*true\\s*\\)`,
      "u"
    ),
  ],
  [
    "advisory-lock-session",
    /\bpg_(?:try_)?advisory_(?:lock|unlock)(?:_shared|_all)?\b/u,
  ],
  [
    "advisory-lock-transaction",
    /\bpg_(?:try_)?advisory_xact_lock(?:_shared)?\b/u,
  ],
  ["listen", new RegExp(`${START}(?:un)?listen\\b`, "u")],
  ["notify", new RegExp(`${START}notify\\b|\\bpg_notify\\s*\\(`, "u")],
  [
    "set-session",
    new RegExp(
      `${START}reset\\b|${START}set\\s+(?!local\\b|transaction\\b|constraints\\b)|\\bset_config\\s*\\((?![^)]*,\\s*true\\s*\\))`,
      "u"
    ),
  ],
  [
    "sql-prepare",
    new RegExp(`${START}(?:prepare|execute|deallocate|discard)\\b`, "u"),
  ],
  ["with-hold-cursor", /\bdeclare\b[^;]*\bwith\s+hold\b/u],
  [
    "temporary-table",
    /\bcreate\s+(?:(?:global|local)\s+)?(?:temp|temporary)\s+table\b/u,
  ],
  ["load", new RegExp(`${START}load\\s+(?:''|\\$\\$)`, "u")],
];

/** The constructs that a SQL text uses (those with tokens of their own), in the order of the two sets. */
export const constructsOf = (sql: string): readonly Construct[] => {
  const words = sqlWords(sql);

  return Arr.filter(
    [...PooledSafeConstructs, ...DirectOnlyConstructs],
    (construct) =>
      Arr.some(
        detectors,
        ([name, detector]) => name === construct && detector.test(words)
      )
  );
};

const directOnly: ReadonlySet<Construct> = new Set(DirectOnlyConstructs);

export const isDirectOnly = (
  construct: Construct
): construct is DirectOnlyConstruct => directOnly.has(construct);

/** What a SQL text uses that Hyperdrive does not take (the third table of the generated page). */
export const forbiddenConstructsOf = (
  sql: string
): readonly DirectOnlyConstruct[] =>
  Arr.filter(constructsOf(sql), isDirectOnly);
