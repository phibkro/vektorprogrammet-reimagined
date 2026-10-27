import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Commands,
  Contact,
  Declarations,
  Domain,
  GrantTable,
  Job,
  JobRegistry,
  Teams,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Result,
} from "effect";

import {
  checkAccountsDocument,
  checkAdministrationDocument,
  checkCommandsDocument,
  checkDocument,
  renderAdministrationDocument,
  renderCommandsDocument,
  renderDocument,
} from "../src/render.ts";

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
        const changed = document.replace("| You are |", "| You ure |");
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
      const missing = document.replace("<!-- docgen:end who -->", "");
      assert.isTrue(
        Result.isFailure(renderDocument(missing, Declarations, GrantTable))
      );

      const nested = document.replace(
        "<!-- docgen:end who -->",
        "<!-- docgen:begin inner -->\n<!-- docgen:end who -->"
      );

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
const sectionOf = (document: string, resource: string): string => {
  const start = document.indexOf(`\n### ${resource}\n`);

  if (start === -1) {
    return "";
  }

  const rest = document.slice(start + 1);
  const next = rest.search(/\n(?:### |<!-- docgen:end)/u);

  return next === -1 ? rest : rest.slice(0, next);
};

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
              document.split(row).length - 1,
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

        const changed = document.replace(
          "| Command | Method |",
          "| Command | Methods |"
        );

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
              document.replace("<!-- docgen:end resources -->", ""),
              Declarations,
              GrantTable
            )
          )
        );

        assert.isTrue(
          Result.isFailure(
            renderCommandsDocument(
              document.replace(
                "<!-- docgen:end resources -->",
                "<!-- docgen:begin inner -->\n<!-- docgen:end resources -->"
              ),
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

describe("spec 0008 falsifier 6: the scheduled jobs are the registry, rendered", () => {
  it.effect(
    "the committed page matches the registry, and lists every registered job and its due rule",
    () =>
      Effect.gen(function* listsEveryJob() {
        const document = yield* administrationSource;

        assert.isTrue(
          Result.isSuccess(
            checkAdministrationDocument(document, Declarations, GrantTable)
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
        const changed = document.replace("| Cadence", "| Cadenze");

        assert.notStrictEqual(changed, document);
        assert.isTrue(
          Result.isFailure(
            checkAdministrationDocument(changed, Declarations, GrantTable)
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
              Arr.filter(JobRegistry.Jobs, (job) => job.name !== "endingSoon")
            )
          )
        );

        assert.isTrue(
          Result.isFailure(
            renderAdministrationDocument(
              document.replace("<!-- docgen:end jobs -->", ""),
              Declarations,
              GrantTable
            )
          )
        );
      })
  );
});
