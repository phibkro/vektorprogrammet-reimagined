/** Pure renderers for the generated parts of docs/system/teams.md. */
import { Commands, Domain, Subject } from "@vektorprogrammet/domain";
import type { Grant, Machine } from "@vektorprogrammet/domain";
import { Array as Arr, Option, Record as Rec, Result } from "effect";

interface Entry {
  readonly name: string;
  readonly summary: string;
  readonly replaces: readonly string[];
  readonly note: string | null;
}

type Declaration = Domain.Declaration;

type GrantRow = Grant.Row;

const cell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ");

const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string =>
  Arr.join(
    [
      `| ${Arr.join(header, " | ")} |`,
      `| ${Arr.join(
        Arr.map(header, () => "---"),
        " | "
      )} |`,
      ...Arr.map(rows, (row) => `| ${Arr.join(Arr.map(row, cell), " | ")} |`),
    ],
    "\n"
  );

const entriesOf = (domain: Declaration): readonly Entry[] => [
  ...Arr.flatMap(domain.commands, (rpc) =>
    Option.match(Commands.infoOf(rpc), {
      onNone: () => [],
      onSome: (info) => [
        {
          name: rpc._tag,
          note: info.note,
          replaces: info.replaces,
          summary: info.summary,
        },
      ],
    })
  ),
  ...Arr.map(Rec.toEntries(domain.reads), ([name, read]) => ({
    name,
    note: null,
    replaces: read.replaces,
    summary: read.summary,
  })),
];

const includes = (row: GrantRow, entry: Entry): boolean =>
  Arr.contains(row.commands, entry.name);

const appliesToTeams = (row: GrantRow, entries: readonly Entry[]): boolean =>
  Arr.some(entries, (entry) => includes(row, entry));

const subjectLabels = (row: GrantRow): string =>
  Arr.join(Arr.map(row.subjects, Subject.label), " or ");

const subjectNames = (row: GrantRow): string =>
  Arr.join(Arr.map(row.subjects, Subject.notation), " ∪ ");

/** One row per grant, with descriptions taken from the commands and reads that the row grants. */
const who = (entries: readonly Entry[], grants: readonly GrantRow[]): string =>
  table(
    ["You are", "You can", "Scope"],
    Arr.map(
      Arr.filter(grants, (row) => appliesToTeams(row, entries)),
      (row) => [
        subjectLabels(row),
        Arr.join(
          Arr.map(
            Arr.filter(entries, (entry) => includes(row, entry)),
            (entry) => entry.summary
          ),
          "<br>"
        ),
        row.scope,
      ]
    )
  );

const transitionLine = (
  transition: Machine.Description["transitions"][number],
  from: string
): string => {
  const suffix = transition.when === undefined ? "" : ` (${transition.when})`;

  return `  ${from} --> ${transition.to} : ${transition.command}${suffix}`;
};

/** Draw the commands and the changes made by time from the same machine. */
const machine = (description: Machine.Description): string =>
  Arr.join(
    [
      "```mermaid",
      "stateDiagram-v2",
      ...Arr.flatMap(description.transitions, (transition) =>
        Arr.map(transition.from, (from) => transitionLine(transition, from))
      ),
      ...Arr.map(
        description.calculated,
        (transition) =>
          `  ${transition.from} --> ${transition.to} : ${transition.when}`
      ),
      "```",
    ],
    "\n"
  );

/** Each command and read gets its own line, so the grants and legacy rules are visible without shorthand. */
const commands = (
  entries: readonly Entry[],
  grants: readonly GrantRow[]
): string =>
  table(
    ["Command or read", "What it does", "Granted to", "Scope", "Replaces"],
    Arr.map(entries, (entry) => {
      const rows = Arr.filter(grants, (row) => includes(row, entry));
      const note = entry.note === null ? "" : ` ${entry.note}`;

      return [
        `\`${entry.name}\``,
        `${entry.summary}${note}`,
        Arr.join(Arr.map(rows, subjectNames), "; "),
        Arr.join(Arr.dedupe(Arr.map(rows, (row) => row.scope)), ", "),
        Arr.join(entry.replaces, ", "),
      ];
    })
  );

const subjects = (): string =>
  table(
    ["Subject set", "Definition"],
    Arr.map(Subject.catalog, (subject) => [
      `\`${subject.notation}\``,
      subject.definition,
    ])
  );

/** Replace exactly one named block. Missing, duplicate, reversed or nested markers are errors. */
const replaceBlock = (
  document: string,
  id: string,
  content: string
): Result.Result<string, string> => {
  const begin = `<!-- docgen:begin ${id} -->`;
  const end = `<!-- docgen:end ${id} -->`;
  const first = document.indexOf(begin);
  const last = document.indexOf(end);

  if (
    first === -1 ||
    last < first ||
    document.includes(begin, first + begin.length) ||
    document.includes(end, last + end.length)
  ) {
    return Result.fail(`Invalid markers for ${id}`);
  }

  const existing = document.slice(first + begin.length, last);

  if (/<!-- docgen:(?:begin|end) /u.test(existing)) {
    return Result.fail(`Nested markers for ${id}`);
  }

  return Result.succeed(
    `${document.slice(0, first)}${begin}\n\n${content}\n\n${document.slice(last)}`
  );
};

/** Refuse incomplete declarations and preserve all text outside the four generated blocks. */
export const renderDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<string, string> => {
  const problems = Arr.flatMap(domains, Domain.problems);

  if (problems.length > 0) {
    return Result.fail(`Incomplete declarations: ${Arr.join(problems, "; ")}`);
  }

  const domain = Option.getOrUndefined(
    Arr.findFirst(domains, (entry) => entry.name === "teams")
  );

  if (domain === undefined) {
    return Result.fail("The teams declaration is missing");
  }

  const membership = Option.getOrUndefined(
    Arr.findFirst(domain.machines, (entry) => entry.name === "Membership")
  );

  if (membership === undefined) {
    return Result.fail("The Membership machine is missing");
  }

  const entries = entriesOf(domain);

  const blocks = [
    ["who", who(entries, grants)],
    ["membership", machine(membership)],
    ["commands", commands(entries, grants)],
    ["subjects", subjects()],
  ] as const;

  let current = document;

  for (const [id, content] of blocks) {
    const updated = replaceBlock(current, id, content);

    if (Result.isFailure(updated)) {
      return updated;
    }

    current = updated.success;
  }

  return Result.succeed(current);
};

/** The check used by CI and the CLI, without writing the document. */
export const checkDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<void, string> =>
  Result.flatMap(renderDocument(document, domains, grants), (generated) =>
    document === generated
      ? Result.void
      : Result.fail("Generated documentation differs. Run bun run docs.")
  );
