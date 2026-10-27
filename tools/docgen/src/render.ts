/** Pure renderers for the declaration-derived teams, accounts, commands-by-resource and scheduled-jobs references. */
import {
  Commands,
  Domain,
  Job,
  JobRegistry,
  Subject,
  codePolicy,
  jobProblems,
} from "@vektorprogrammet/domain";
import type { Grant, Machine } from "@vektorprogrammet/domain";
import { Array as Arr, Option, Order, Record as Rec, Result } from "effect";

interface Entry {
  readonly name: string;
  readonly summary: string;
  readonly replaces: readonly string[];
  readonly note: string | null;
  /** What a command acts on, and how (ADR 0010); a read has neither. */
  readonly resource: string;
  readonly method: string;
}

type Declaration = Domain.Declaration;

type GrantRow = Grant.Row;

const cell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ");

const tableRow = (values: readonly string[]): string =>
  `| ${Arr.join(Arr.map(values, cell), " | ")} |`;

/** Unlike an import report, a reference table keeps its header when no rows exist. */
const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string => {
  const lines = [tableRow(header), tableRow(Arr.map(header, () => "---"))];

  for (const row of rows) {
    lines.push(tableRow(row));
  }

  return Arr.join(lines, "\n");
};

/** Oxfmt aligns short Markdown tables. Emit that same layout so generation and formatting agree. */
const alignedTable = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string => {
  const escaped = Arr.map(rows, (row) => Arr.map(row, cell));
  const headings = Arr.map(header, cell);

  const widths = Arr.map(headings, (heading, index) =>
    Arr.reduce(escaped, Math.max(heading.length, 3), (width, row) =>
      Math.max(width, (row[index] ?? "").length)
    )
  );

  const line = (values: readonly string[]) =>
    `| ${Arr.join(
      Arr.map(values, (value, index) => value.padEnd(widths[index] ?? 3)),
      " | "
    )} |`;

  return Arr.join(
    [
      line(headings),
      line(Arr.map(widths, (width) => "-".repeat(width))),
      ...Arr.map(escaped, line),
    ],
    "\n"
  );
};

/** A method as the page shows it: a standard one as written, a custom one with its colon (`:extend`). */
const methodLabel = (method: Commands.Method): string => `\`${method}\``;

const entriesOf = (domain: Declaration): readonly Entry[] => [
  ...Arr.flatMap(domain.commands, (rpc) =>
    Option.match(Commands.infoOf(rpc), {
      onNone: () => [],
      onSome: (info) => [
        {
          method: methodLabel(info.method),
          name: rpc._tag,
          note: info.note,
          replaces: info.replaces,
          resource: info.resource,
          summary: info.summary,
        },
      ],
    })
  ),
  ...Arr.map(Rec.toEntries(domain.reads), ([name, read]) => ({
    method: "—",
    name,
    note: null,
    replaces: read.replaces,
    resource: "—",
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
    [
      "Command or read",
      "Resource",
      "Method",
      "What it does",
      "Granted to",
      "Scope",
      "Replaces",
    ],
    Arr.map(entries, (entry) => {
      const rows = Arr.filter(grants, (row) => includes(row, entry));
      const note = entry.note === null ? "" : ` ${entry.note}`;

      return [
        `\`${entry.name}\``,
        entry.resource,
        entry.method,
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

/** The declarations, or the reason that a generator must not render them: every domain complete, and no name shared. */
const completeDomains = (
  domains: readonly Declaration[]
): Result.Result<readonly Declaration[], string> => {
  const problems = Domain.allProblems(domains);

  return problems.length > 0
    ? Result.fail(`Incomplete declarations: ${Arr.join(problems, "; ")}`)
    : Result.succeed(domains);
};

/** Validate the declarations and select the one machine a reference describes. */
const declaredMachine = (
  domains: readonly Declaration[],
  name: string,
  machineName: string
) =>
  Result.flatMap(completeDomains(domains), () => {
    const domain = Option.getOrUndefined(
      Arr.findFirst(domains, (entry) => entry.name === name)
    );

    if (domain === undefined) {
      return Result.fail(`The ${name} declaration is missing`);
    }

    const diagram = Option.getOrUndefined(
      Arr.findFirst(domain.machines, (entry) => entry.name === machineName)
    );

    return diagram === undefined
      ? Result.fail(`The ${machineName} machine is missing`)
      : Result.succeed({ diagram, domain });
  });

/** One command of one domain, with the pair that ADR 0010 gives it. */
interface DeclaredCommand {
  readonly domain: string;
  readonly name: string;
  readonly info: Commands.CommandInfo;
}

/** Where a method sorts within its resource: the standard methods in their own order, then the custom ones as declared. */
const methodRank = (method: Commands.Method): number =>
  Option.getOrElse(
    Arr.findFirstIndex(
      Commands.StandardMethods,
      (standard) => standard === method
    ),
    () => Commands.StandardMethods.length
  );

const resourceSection = (
  resource: Commands.Resource,
  found: readonly DeclaredCommand[],
  grants: readonly GrantRow[]
): string =>
  Arr.join(
    [
      `### ${resource}`,
      table(
        ["Command", "Method", "Domain", "What it does", "Granted to"],
        Arr.map(found, ({ domain, info, name }) => {
          const rows = Arr.filter(grants, (row) =>
            Arr.contains(row.commands, name)
          );

          const note = info.note === null ? "" : ` ${info.note}`;

          return [
            `\`${name}\``,
            methodLabel(info.method),
            domain,
            `${info.summary}${note}`,
            Arr.join(Arr.map(rows, subjectNames), "; "),
          ];
        })
      ),
    ],
    "\n\n"
  );

/**
 * Every command of every domain, under the resource that it acts on, in the order of the closed set of resources; a
 * resource that no command acts on has no section. This is the page that answers "what can be done to a membership?".
 */
const byResource = (
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): string => {
  const declared: readonly DeclaredCommand[] = Arr.flatMap(domains, (domain) =>
    Arr.flatMap(domain.commands, (rpc) =>
      Option.match(Commands.infoOf(rpc), {
        onNone: () => [],
        onSome: (info) => [{ domain: domain.name, info, name: rpc._tag }],
      })
    )
  );

  const byMethod = Order.mapInput(Order.Number, (command: DeclaredCommand) =>
    methodRank(command.info.method)
  );

  return Arr.join(
    Arr.flatMap(Commands.Resources, (resource) => {
      const found = Arr.sort(
        Arr.filter(
          declared,
          (command: DeclaredCommand) => command.info.resource === resource
        ),
        byMethod
      );

      return Arr.isReadonlyArrayNonEmpty(found)
        ? [resourceSection(resource, found, grants)]
        : [];
    }),
    "\n\n"
  );
};

/** Preserve text outside the named blocks. */
const replaceBlocks = (
  document: string,
  blocks: readonly (readonly [string, string])[]
): Result.Result<string, string> => {
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

const checkRendered = (
  document: string,
  output: Result.Result<string, string>
): Result.Result<void, string> =>
  Result.flatMap(output, (generated) =>
    document === generated
      ? Result.void
      : Result.fail("Generated documentation differs. Run bun run docs.")
  );

/** Refuse incomplete declarations and preserve all text outside the four generated blocks. */
export const renderDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<string, string> =>
  Result.flatMap(
    declaredMachine(domains, "teams", "Membership"),
    ({ diagram, domain }) => {
      const entries = entriesOf(domain);

      return replaceBlocks(document, [
        ["who", who(entries, grants)],
        ["membership", machine(diagram)],
        ["commands", commands(entries, grants)],
        ["subjects", subjects()],
      ]);
    }
  );

/** The check used by CI and the CLI, without writing the document. */
export const checkDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<void, string> =>
  checkRendered(document, renderDocument(document, domains, grants));

/** Account commands, grants, machine and code policy come from the same declarations the runtime uses. */
export const renderAccountsDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<string, string> =>
  Result.flatMap(
    declaredMachine(domains, "accounts", "Account"),
    ({ diagram, domain }) => {
      const entries = entriesOf(domain);

      const policy = alignedTable(
        ["Purpose", "Command", "Lifetime (hours)"],
        Arr.map(Rec.toEntries(codePolicy), ([purpose, value]) => [
          purpose,
          value.command,
          String(value.lifetimeSeconds / 3600),
        ])
      );

      return replaceBlocks(document, [
        ["who", who(entries, grants)],
        ["account", machine(diagram)],
        ["commands", commands(entries, grants)],
        ["code-policy", policy],
      ]);
    }
  );

export const checkAccountsDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<void, string> =>
  checkRendered(document, renderAccountsDocument(document, domains, grants));

/** Every command by resource, from all the declarations (ADR 0010): one block of the page that `commands.md` holds. */
export const renderCommandsDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<string, string> =>
  Result.flatMap(completeDomains(domains), (complete) =>
    replaceBlocks(document, [["resources", byResource(complete, grants)]])
  );

export const checkCommandsDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[]
): Result.Result<void, string> =>
  checkRendered(document, renderCommandsDocument(document, domains, grants));

/**
 * The scheduled jobs of the registry (spec 0008): what each does, when it is due, its cron and whether it is approved.
 * Wide, so Oxfmt keeps it compact (`table`); `alignedTable` is for the short tables that it aligns.
 */
const jobsTable = (jobs: readonly Job.Job[]): string =>
  table(
    ["Job", "Does", "Due", "Cron", "Cadence"],
    Arr.map(jobs, (job) => [
      `\`${job.name}\``,
      job.summary,
      Arr.join(Arr.map(job.dueWhen, Job.describeDueWhen), "; "),
      `\`${job.schedule.cron}\``,
      job.schedule.status === "proposed" ? "proposed \\*" : "approved",
    ])
  );

/**
 * `administration.md`: the table of scheduled jobs is the registry, rendered. The registry is checked against the
 * declarations first (`jobProblems`), so a job without a declaration, a command or a name is refused here too. `jobs`
 * is the real registry; the tests pass a changed one to show that a changed declaration changes the page.
 */
export const renderAdministrationDocument = (
  document: string,
  domains: readonly Declaration[],
  _grants: readonly GrantRow[],
  jobs: readonly Job.Job[] = JobRegistry.Jobs
): Result.Result<string, string> =>
  Result.flatMap(completeDomains(domains), (complete) => {
    const problems = jobProblems(jobs, complete);

    return problems.length > 0
      ? Result.fail(`Incomplete job registry: ${Arr.join(problems, "; ")}`)
      : replaceBlocks(document, [["jobs", jobsTable(jobs)]]);
  });

export const checkAdministrationDocument = (
  document: string,
  domains: readonly Declaration[],
  grants: readonly GrantRow[],
  jobs: readonly Job.Job[] = JobRegistry.Jobs
): Result.Result<void, string> =>
  checkRendered(
    document,
    renderAdministrationDocument(document, domains, grants, jobs)
  );
