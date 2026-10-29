import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Catalog,
  Commands,
  Contact,
  Declarations,
  Domain,
  Forms,
  GrantTable,
  Job,
  JobRegistry,
  Teams,
  approvalWords,
  codePolicy,
  personalColumns,
  recordOfProcessing,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Record as Rec,
  Result,
  String as Str,
} from "effect";

import {
  approvalCell,
  checkAccountsDocument,
  checkAdministrationDocument,
  checkCommandsDocument,
  checkDocument,
  renderAdministrationDocument,
  renderCommandsDocument,
  renderDocument,
} from "../src/render.ts";
import type { PersonalDataSources } from "../src/render.ts";

const source = Effect.gen(function* source() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/teams.md");
}).pipe(Effect.provide(NodeServices.layer));

describe("spec 0006 falsifier 8: generated documentation", () => {
  it.effect(
    "falsifier 8: the committed teams document matches the declarations",
    () =>
      Effect.gen(function* matches() {
        const document = yield* source;
        const checked = checkDocument(document, Declarations, GrantTable);
        assert.isTrue(Result.isSuccess(checked));
      })
  );

  it.effect(
    "falsifier 8, negative control: one changed character in a generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const document = yield* source;
        const changed = Str.replace("| You are |", "| You ure |")(document);
        assert.notStrictEqual(changed, document);
        assert.isTrue(
          Result.isFailure(checkDocument(changed, Declarations, GrantTable))
        );
      })
  );

  it.effect(
    "falsifier 8, negative control: removing one grant row without regenerating fails the check",
    () =>
      Effect.gen(function* removedGrant() {
        const document = yield* source;

        const reduced = Arr.filter(
          GrantTable,
          (row) => !Arr.contains(row.commands, "createTeam")
        );

        assert.isBelow(reduced.length, GrantTable.length);
        assert.isTrue(
          Result.isFailure(checkDocument(document, Declarations, reduced))
        );
      })
  );

  it.effect("incomplete declarations and invalid markers are refused", () =>
    Effect.gen(function* invalid() {
      const document = yield* source;

      const incomplete: Domain.Declaration = {
        ...Teams.TeamsDomain,
        table: [],
      };

      assert.isTrue(
        Result.isFailure(renderDocument(document, [incomplete], GrantTable))
      );
      const missing = Str.replace("<!-- docgen:end who -->", "")(document);
      assert.isTrue(
        Result.isFailure(renderDocument(missing, Declarations, GrantTable))
      );

      const nested = Str.replace(
        "<!-- docgen:end who -->",
        "<!-- docgen:begin inner -->\n<!-- docgen:end who -->"
      )(document);

      assert.isTrue(
        Result.isFailure(renderDocument(nested, Declarations, GrantTable))
      );
    })
  );
});

describe("spec 0007: generated account documentation", () => {
  it.effect(
    "the account reference matches its declaration, and removing its grant makes the check fail",
    () =>
      Effect.gen(function* accountReference() {
        const fs = yield* FileSystem.FileSystem;

        const document = yield* fs.readFileString(
          "../../docs/system/accounts.md"
        );

        assert.isTrue(
          Result.isSuccess(
            checkAccountsDocument(document, Declarations, GrantTable)
          )
        );

        const reduced = Arr.filter(
          GrantTable,
          (row) => !Arr.contains(row.commands, "activateAccount")
        );

        assert.isBelow(reduced.length, GrantTable.length);
        assert.isTrue(
          Result.isFailure(
            checkAccountsDocument(document, Declarations, reduced)
          )
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});

const commandsSource = Effect.gen(function* commandsSource() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/commands.md");
}).pipe(Effect.provide(NodeServices.layer));

/** The section of `resource` in the generated page: its heading up to the next heading, or the end of the block. */
const sectionOf = (document: string, resource: string): string =>
  Option.match(Str.indexOf(`\n### ${resource}\n`)(document), {
    onNone: () => "",
    onSome: (start) => {
      const rest = Str.slice(start + 1)(document);

      return Option.match(Str.search(rest, /\n(?:### |<!-- docgen:end)/u), {
        onNone: () => rest,
        onSome: (next) => Str.slice(0, next)(rest),
      });
    },
  });

describe("spec 0007c falsifier 5: every command by resource", () => {
  it.effect(
    "the committed page matches the declarations, and lists every command once, under the resource it declares",
    () =>
      Effect.gen(function* listsEveryCommand() {
        const document = yield* commandsSource;

        assert.isTrue(
          Result.isSuccess(
            checkCommandsDocument(document, Declarations, GrantTable)
          )
        );

        for (const domain of Declarations) {
          for (const rpc of domain.commands) {
            const row = `| \`${rpc._tag}\` |`;

            assert.strictEqual(
              Str.split(document, row).length - 1,
              1,
              `${rpc._tag} is listed once`
            );

            const resource = Commands.infoOf(rpc).pipe(
              Option.map((info) => info.resource),
              Option.getOrElse(() => "no resource")
            );

            assert.include(
              sectionOf(document, resource),
              row,
              `${rpc._tag} is under ${resource}`
            );
          }
        }
      })
  );

  it.effect(
    "negative control: one changed character in the generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const document = yield* commandsSource;

        const changed = Str.replace(
          "| Command | Method |",
          "| Command | Methods |"
        )(document);

        assert.notStrictEqual(changed, document);
        assert.isTrue(
          Result.isFailure(
            checkCommandsDocument(changed, Declarations, GrantTable)
          )
        );
      })
  );

  it.effect(
    "negative control: a command moved to another resource in its declaration, without regenerating, fails the check; regenerating makes it pass",
    () =>
      Effect.gen(function* movedCommand() {
        const document = yield* commandsSource;

        const moved = Contact.submitContact.annotate(
          Commands.Info,
          Commands.info({
            method: ":submit",
            replaces: ["RULE-156", "RULE-249"],
            resource: "Person",
            summary: "Send a message to a department's contact address.",
          })
        );

        const domains = Arr.map(Declarations, (domain): Domain.Declaration =>
          domain.name === "contact" ? { ...domain, commands: [moved] } : domain
        );

        assert.deepStrictEqual(Domain.allProblems(domains), []);
        assert.isTrue(
          Result.isFailure(checkCommandsDocument(document, domains, GrantTable))
        );

        const regenerated = renderCommandsDocument(
          document,
          domains,
          GrantTable
        );

        assert.isTrue(Result.isSuccess(regenerated));
        assert.isTrue(
          Result.isSuccess(
            Result.flatMap(regenerated, (text) =>
              checkCommandsDocument(text, domains, GrantTable)
            )
          )
        );
      })
  );

  it.effect(
    "an incomplete declaration, a missing marker and a nested marker are refused",
    () =>
      Effect.gen(function* refused() {
        const document = yield* commandsSource;

        const misnamed = Teams.createTeam.annotate(
          Commands.Info,
          Commands.info({
            method: "create",
            resource: "Person",
            summary: "Create a team in a department.",
          })
        );

        const unnamed: Domain.Declaration = {
          ...Teams.TeamsDomain,
          commands: Arr.map(Teams.TeamsDomain.commands, (rpc) =>
            Predicate.isTagged(rpc, "createTeam") ? misnamed : rpc
          ),
        };

        assert.isTrue(
          Result.isFailure(
            renderCommandsDocument(document, [unnamed], GrantTable)
          )
        );

        assert.isTrue(
          Result.isFailure(
            renderCommandsDocument(
              Str.replace("<!-- docgen:end resources -->", "")(document),
              Declarations,
              GrantTable
            )
          )
        );

        assert.isTrue(
          Result.isFailure(
            renderCommandsDocument(
              Str.replace(
                "<!-- docgen:end resources -->",
                "<!-- docgen:begin inner -->\n<!-- docgen:end resources -->"
              )(document),
              Declarations,
              GrantTable
            )
          )
        );
      })
  );
});

const administrationSource = Effect.gen(function* administrationSource() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString("../../docs/system/administration.md");
}).pipe(Effect.provide(NodeServices.layer));

const SOURCES: PersonalDataSources = { catalog: Catalog, forms: Forms };

/** The two answers of a decision, for a test over every combination of the period's and the basis's. */
const APPROVALS = ["decided", "proposed"] as const;

/** The text between a block's markers. */
const blockOf = (document: string, id: string): string => {
  const begin = `<!-- docgen:begin ${id} -->`;
  const first = Option.getOrThrow(Str.indexOf(begin)(document)) + begin.length;

  return Str.slice(
    first,
    Option.getOrThrow(Str.indexOf(`<!-- docgen:end ${id} -->`)(document))
  )(document);
};

describe("spec 0007b falsifier 1: generated personal data documentation", () => {
  it.effect(
    "the committed administration document matches the catalog, the forms and the declarations",
    () =>
      Effect.gen(function* matches() {
        const document = yield* administrationSource;

        assert.isTrue(
          Result.isSuccess(
            checkAdministrationDocument(
              document,
              Declarations,
              GrantTable,
              SOURCES
            )
          )
        );
      })
  );

  it.effect(
    "negative controls: one changed character, a table left out of the catalog, a form left out, or a grant removed fails the check",
    () =>
      Effect.gen(function* drift() {
        const document = yield* administrationSource;

        const fails = (
          changed: string,
          sources = SOURCES,
          grants = GrantTable
        ) =>
          Result.isFailure(
            checkAdministrationDocument(changed, Declarations, grants, sources)
          );

        const changed = Str.replace("| Data |", "| Dats |")(document);
        assert.notStrictEqual(changed, document);
        assert.isTrue(fails(changed));

        // A table that the catalog no longer holds is still in the committed record.
        assert.isTrue(
          fails(document, {
            ...SOURCES,
            catalog: Rec.remove(Catalog, "outbox"),
          })
        );

        // A form that is no longer declared is still in the committed notices.
        assert.isTrue(fails(document, { ...SOURCES, forms: [] }));

        const reduced = Arr.filter(
          GrantTable,
          (row) => !Arr.contains(row.commands, "erasePerson")
        );

        assert.isBelow(reduced.length, GrantTable.length);
        assert.isTrue(fails(document, SOURCES, reduced));
      })
  );

  it.effect(
    "a proposal is marked in the schedule: as many marks as proposed rows, and none for a decided one",
    () =>
      Effect.gen(function* marks() {
        const document = yield* administrationSource;
        const rows = recordOfProcessing(Catalog);

        const proposed = Arr.filter(
          rows,
          (row) => row.periodApproval === "proposed"
        );

        const lines = Str.split(blockOf(document, "retention"), "\n");

        const marked = Arr.filter(lines, (line) =>
          Str.includes(" \\* |")(line)
        );

        assert.isAbove(proposed.length, 0);
        assert.isBelow(proposed.length, rows.length);
        assert.strictEqual(marked.length, proposed.length);
      })
  );

  it("the record's approval cell names the open decisions: the period, the legal basis, both, and nothing once both are made", () => {
    const sample = Option.getOrThrow(Arr.head(recordOfProcessing(Catalog)));

    const words = Option.getOrThrow(
      Option.fromNullishOr(approvalWords.proposed)
    ).en;

    for (const period of APPROVALS) {
      for (const basis of APPROVALS) {
        const cell = approvalCell({
          ...sample,
          basisApproval: basis,
          periodApproval: period,
        });

        const said = `${period} period, ${basis} basis: "${cell}"`;

        assert.strictEqual(
          Str.includes("period")(cell),
          period === "proposed",
          said
        );
        assert.strictEqual(
          Str.includes("legal basis")(cell),
          basis === "proposed",
          said
        );
        assert.strictEqual(
          Str.includes(words)(cell),
          period === "proposed" || basis === "proposed",
          said
        );
        assert.strictEqual(
          cell === "decided",
          period === "decided" && basis === "decided",
          said
        );
      }
    }
  });

  it.effect(
    "the committed record says, row by row, which decisions the declarations leave open: every row has one of the four cells, in the numbers that the declarations give",
    () =>
      Effect.gen(function* rowsSay() {
        const document = yield* administrationSource;
        const lines = Str.split(blockOf(document, "record"), "\n");
        const rows = recordOfProcessing(Catalog);
        const sample = Option.getOrThrow(Arr.head(rows));
        let found = 0;

        for (const period of APPROVALS) {
          for (const basis of APPROVALS) {
            const cell = approvalCell({
              ...sample,
              basisApproval: basis,
              periodApproval: period,
            });

            const expected = Arr.filter(
              rows,
              (row) =>
                row.periodApproval === period && row.basisApproval === basis
            ).length;

            const listed = Arr.filter(lines, (line) =>
              Str.endsWith(`| ${cell} |`)(line)
            ).length;

            assert.strictEqual(listed, expected, cell);
            found += listed;
          }
        }

        assert.isAbove(rows.length, 0);
        assert.strictEqual(found, rows.length);
      })
  );

  it.effect("the record lists every personal column of the catalog", () =>
    Effect.gen(function* complete() {
      const document = yield* administrationSource;
      const record = blockOf(document, "record");

      for (const [table, declaration] of Rec.toEntries(Catalog)) {
        for (const [column] of personalColumns(declaration)) {
          // `table`: a, b, c: the column is one item of its table's list.
          const listed = new RegExp(
            `\`${table}\`: (?:[a-z_0-9]+, )*${column}(?:,|<br>| \\|)`,
            "u"
          );

          assert.isTrue(listed.test(record), `${table}.${column}`);
        }
      }
    })
  );

  it.effect("a document without the personal data declaration is refused", () =>
    Effect.gen(function* refused() {
      const document = yield* administrationSource;

      const withoutPersonalData = Arr.filter(
        Declarations,
        (domain) => domain.name !== "personalData"
      );

      assert.isBelow(withoutPersonalData.length, Declarations.length);

      assert.isTrue(
        Result.isFailure(
          renderAdministrationDocument(
            document,
            withoutPersonalData,
            GrantTable,
            SOURCES
          )
        )
      );

      assert.isTrue(
        Result.isFailure(
          renderAdministrationDocument(
            Str.replace("<!-- docgen:end record -->", "")(document),
            Declarations,
            GrantTable,
            SOURCES
          )
        )
      );
    })
  );

  it.effect(
    "the code policy table says which purpose is reusable, and the account that a purpose needs",
    () =>
      Effect.gen(function* policy() {
        const fs = yield* FileSystem.FileSystem;

        const document = yield* fs.readFileString(
          "../../docs/system/accounts.md"
        );

        const block = blockOf(document, "code-policy");

        for (const [purpose, value] of Rec.toEntries(codePolicy)) {
          const line = Arr.findFirst(Str.split(block, "\n"), (row) =>
            Str.startsWith(`| ${purpose} `)(row)
          );

          assert.isTrue(Option.isSome(line), purpose);

          assert.isTrue(
            Option.exists(line, (row) =>
              Str.includes(`| ${value.singleUse ? "yes" : "no"} `)(row)
            ),
            purpose
          );
        }

        assert.include(block, "| alumniConsent");
      }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("spec 0008 falsifier 6: the scheduled jobs are the registry, rendered", () => {
  it.effect(
    "the committed page matches the registry, and lists every registered job and its due rule",
    () =>
      Effect.gen(function* listsEveryJob() {
        const document = yield* administrationSource;

        assert.isTrue(
          Result.isSuccess(
            checkAdministrationDocument(
              document,
              Declarations,
              GrantTable,
              SOURCES
            )
          )
        );

        for (const job of JobRegistry.Jobs) {
          assert.include(
            document,
            `| \`${job.name}\` |`,
            `${job.name} is listed`
          );

          for (const rule of job.dueWhen) {
            assert.include(document, Job.describeDueWhen(rule));
          }
        }
      })
  );

  it.effect(
    "negative control: changing one declaration without regenerating fails the check",
    () =>
      Effect.gen(function* changedDeclaration() {
        const document = yield* administrationSource;

        const approved = Arr.map(JobRegistry.Jobs, (job) =>
          job.name === "workspaceSync"
            ? Job.make({
                ...job,
                name: job.name,
                schedule: { ...job.schedule, status: "approved" },
              })
            : job
        );

        assert.isTrue(
          Result.isFailure(
            checkAdministrationDocument(
              document,
              Declarations,
              GrantTable,
              SOURCES,
              approved
            )
          )
        );

        const later = Arr.map(JobRegistry.Jobs, (job) =>
          job.name === "workspaceSync"
            ? Job.make({
                ...job,
                dueWhen: [Job.DueWhen.cases.Daily.make({ hour: 3 })],
                name: job.name,
              })
            : job
        );

        assert.isTrue(
          Result.isFailure(
            checkAdministrationDocument(
              document,
              Declarations,
              GrantTable,
              SOURCES,
              later
            )
          )
        );
      })
  );

  it.effect(
    "negative control: one changed character in the generated block fails the check",
    () =>
      Effect.gen(function* changedCharacter() {
        const document = yield* administrationSource;
        const changed = Str.replace("| Cadence", "| Cadenze")(document);

        assert.notStrictEqual(changed, document);
        assert.isTrue(
          Result.isFailure(
            checkAdministrationDocument(
              changed,
              Declarations,
              GrantTable,
              SOURCES
            )
          )
        );
      })
  );

  it.effect(
    "negative control: an incomplete registry, or invalid markers, are refused",
    () =>
      Effect.gen(function* refused() {
        const document = yield* administrationSource;

        // A System principal without a declaration.
        assert.isTrue(
          Result.isFailure(
            renderAdministrationDocument(
              document,
              Declarations,
              GrantTable,
              SOURCES,
              Arr.filter(JobRegistry.Jobs, (job) => job.name !== "endingSoon")
            )
          )
        );

        assert.isTrue(
          Result.isFailure(
            renderAdministrationDocument(
              Str.replace("<!-- docgen:end jobs -->", "")(document),
              Declarations,
              GrantTable,
              SOURCES
            )
          )
        );
      })
  );
});
