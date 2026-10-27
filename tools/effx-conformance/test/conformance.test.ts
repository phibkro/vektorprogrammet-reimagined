/**
 * Spec 0007d, falsifiers 1 to 4: the committed descriptions are the declarations' export, the committed vectors are the
 * ones that effx made from them, the kernel's `authorize` and machine tables answer every row of the vectors as they
 * say, and what effx cannot state is the committed register of gaps. Each check has a negative control that changes one
 * thing and fails.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  Effx,
  Grant,
  GrantTable,
  Subject,
  Teams,
  authorizeWith,
} from "@vektorprogrammet/domain";
import type { Domain, Machine } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import {
  Pin,
  Provenance,
  descriptionFile,
  directory,
  gapsFile,
  gunzip,
  pinFile,
  provenanceFile,
  readJson,
  sha256Hex,
  utf8,
  vectorsFile,
} from "../src/artefacts.ts";
import type { PinFile, ProvenanceFile } from "../src/artefacts.ts";
import { compare, machineUnderTest } from "../src/conformance.ts";
import type { Report } from "../src/conformance.ts";
import { derive } from "../src/generate.ts";
import type { Derived } from "../src/generate.ts";
import { machines } from "../src/machines.ts";
import { Vectors, countRows } from "../src/vectors.ts";
import type { VectorsFile } from "../src/vectors.ts";

/** Everything committed, read once: the decoded vectors are large. */
class Committed extends Context.Service<
  Committed,
  {
    readonly derived: Derived;
    readonly files: readonly string[];
    readonly gaps: string;
    readonly pin: PinFile;
    readonly provenance: ProvenanceFile;
    readonly texts: Readonly<Record<string, string>>;
    readonly vectors: Readonly<
      Record<string, { readonly decoded: VectorsFile; readonly sha256: string }>
    >;
  }
>()("effx-conformance/test/Committed") {
  static readonly layer = Layer.effect(
    Committed,
    Effect.gen(function* load() {
      const fs = yield* FileSystem.FileSystem;
      const provenance = yield* readJson(Provenance, provenanceFile);
      const domains = Rec.keys(provenance.domains);

      const texts = Rec.fromEntries(
        yield* Effect.forEach(domains, (domain) =>
          Effect.map(
            fs.readFileString(descriptionFile(domain)),
            (text) => [domain, text] as const
          )
        )
      );

      const vectors = Rec.fromEntries(
        yield* Effect.forEach(domains, (domain) =>
          Effect.gen(function* one() {
            const bytes = yield* Effect.flatMap(
              fs.readFile(vectorsFile(domain)),
              gunzip
            );

            const decoded = yield* Schema.decodeEffect(
              Schema.fromJsonString(Vectors)
            )(new TextDecoder().decode(bytes));

            return [
              domain,
              { decoded, sha256: yield* sha256Hex(bytes) },
            ] as const;
          })
        )
      );

      return Committed.of({
        derived: yield* derive(),
        files: yield* fs.readDirectory(directory),
        gaps: yield* fs.readFileString(gapsFile),
        pin: yield* readJson(Pin, pinFile),
        provenance,
        texts,
        vectors,
      });
    })
  ).pipe(Layer.provide(NodeServices.layer));
}

const hash = (bytes: Uint8Array) =>
  sha256Hex(bytes).pipe(Effect.provide(NodeServices.layer));

/** The committed vectors of a domain, asked of the kernel with `table` and `machines` standing in for its own. */
const conform = Effect.fn("conform")(function* conform(
  domain: string,
  stand: {
    readonly machines?: typeof machines;
    readonly table?: typeof GrantTable;
  } = {}
) {
  const committed = yield* Committed;
  const found = committed.vectors[domain];

  const description = Arr.findFirst(
    committed.derived.descriptions,
    (item) => item.domain === domain
  );

  if (found === undefined || Option.isNone(description)) {
    return assert.fail(`no vectors or description for ${domain}`);
  }

  const order = Arr.map(
    description.value.description.machines,
    ({ name }) => name
  );

  return compare(found.decoded, {
    authorize: authorizeWith<string>(stand.table ?? GrantTable),
    machineOrder: order,
    machines: Arr.filter(stand.machines ?? machines, ({ name }) =>
      order.includes(name)
    ),
  });
});

/** Whether there are disagreements, and every one of them is of the kind that `test` accepts. */
const onlyThese = (
  report: Report,
  test: (row: Report["disagreements"][number]) => boolean
) => report.disagreements.length > 0 && Arr.every(report.disagreements, test);

const isLeader = Predicate.isTagged("Leader");

const isMember = Predicate.isTagged("Member");

const lines = (text: string | undefined) => (text ?? "").split("\n");

/**
 * What differs between the committed descriptions and the export: a line for each domain whose text differs, naming
 * the domain and the first line that does. The check and its negative controls both ask this.
 */
const drift = (
  committed: Readonly<Record<string, string>>,
  exported: readonly { readonly domain: string; readonly text: string }[]
): readonly string[] =>
  Arr.flatMap(exported, ({ domain, text }) => {
    const have = lines(committed[domain]);
    const want = lines(text);

    return Option.match(
      Arr.findFirst(
        Arr.range(0, Math.max(have.length, want.length) - 1),
        (line) => have[line] !== want[line]
      ),
      {
        onNone: () => [],
        onSome: (line) => [
          `${domain}: line ${line + 1} of the committed description is ${JSON.stringify(have[line])}, the export says ${JSON.stringify(want[line])}`,
        ],
      }
    );
  });

const isViewTeams = (row: Domain.Declaration["table"][number]) =>
  Arr.contains(row.commands, "viewTeams") && Arr.some(row.subjects, isMember);

/** A machine with one state called by another name, everywhere that it is named. */
const renamed = (
  machine: Machine.Description,
  from: string,
  to: string
): Machine.Description => {
  const rename = (state: string) => (state === from ? to : state);

  return {
    ...machine,
    calculated: Arr.map(machine.calculated, (change) => ({
      ...change,
      from: rename(change.from),
      to: rename(change.to),
    })),
    states: Arr.map(machine.states, rename),
    terminal: Arr.map(machine.terminal, rename),
    transitions: Arr.map(machine.transitions, (transition) => ({
      ...transition,
      from: Arr.map(transition.from, rename),
      to: rename(transition.to),
    })),
  };
};

/** The `teams` declaration with one fact changed, as a developer would change it. */
const mutants = {
  "a grant row deleted": {
    ...Teams.TeamsDomain,
    table: Arr.filter(Teams.TeamsDomain.table, (row) => !isViewTeams(row)),
  },
  "a scope changed": {
    ...Teams.TeamsDomain,
    table: Arr.map(Teams.TeamsDomain.table, (row) =>
      isViewTeams(row) ? { ...row, scope: "all" as const } : row
    ),
  },
  "a state renamed": {
    ...Teams.TeamsDomain,
    machines: [renamed(Teams.MembershipMachine, "Ended", "Finished")],
  },
} satisfies Readonly<Record<string, Domain.Declaration>>;

layer(Committed.layer)("spec 0007d: the kernel and effx's vectors", (it) => {
  it.effect(
    "falsifier 1: every committed description is the export of the declarations now",
    () =>
      Effect.gen(function* committedFiles() {
        const committed = yield* Committed;

        assert.deepStrictEqual(
          Rec.keys(committed.texts),
          Arr.map(committed.derived.descriptions, ({ domain }) => domain)
        );

        assert.deepStrictEqual(
          drift(committed.texts, committed.derived.descriptions),
          [],
          "a committed description differs from the export of the declarations"
        );

        assert.deepStrictEqual(
          Arr.sort(committed.files, Order.String),
          Arr.sort(
            [
              ...Arr.flatMap(committed.derived.descriptions, ({ domain }) => [
                `${domain}.description.json`,
                `${domain}.vectors.json.gz`,
              ]),
              "effx.pin.json",
              "gaps.json",
              "provenance.json",
            ],
            Order.String
          )
        );
      })
  );

  it.effect(
    "falsifier 1, negative controls: a grant row deleted, a scope changed or a state renamed in a declaration is a drift that names its domain and its line",
    () =>
      Effect.gen(function* controls() {
        const committed = yield* Committed;

        for (const [change, declaration] of Rec.toEntries(mutants)) {
          const text = Option.match(Effx.describe(declaration).description, {
            onNone: () => "",
            onSome: (description) => Effx.committedJson(description),
          });

          const found = drift(committed.texts, [{ domain: "teams", text }]);

          assert.lengthOf(found, 1, change);
          assert.match(
            found[0] ?? "",
            /^teams: line \d+ of the committed/u,
            change
          );
        }
      })
  );

  it.effect(
    "falsifier 1, negative control: a hand edit of a committed description is a drift that names its domain and its line",
    () =>
      Effect.gen(function* control() {
        const committed = yield* Committed;

        // The committed texts stand for the export, so that this control goes red for its own edit and for nothing else.
        const asExported = Arr.map(
          Rec.toEntries(committed.texts),
          ([domain, text]) => ({
            domain,
            text,
          })
        );

        const edited = {
          ...committed.texts,
          accounts: (committed.texts.accounts ?? "").replace(
            "createAccount",
            "createAccounts"
          ),
        };

        const found = drift(edited, asExported);

        assert.lengthOf(found, 1);
        assert.match(found[0] ?? "", /^accounts: line \d+ of the committed/u);
      })
  );

  it.effect("falsifier 4: the committed register of gaps is the export's", () =>
    Effect.gen(function* register() {
      const committed = yield* Committed;

      assert.strictEqual(committed.gaps, committed.derived.gaps);
    })
  );

  it.effect(
    "falsifier 4, negative control: a subject that effx cannot state adds a gap to the register",
    () =>
      Effect.gen(function* control() {
        const committed = yield* Committed;

        const widened = Effx.describe({
          ...Teams.TeamsDomain,
          table: [
            ...Teams.TeamsDomain.table,
            Grant.make([Subject.anyone], ["viewTeams"], "all"),
          ],
        });

        const added = Arr.flatMap(widened.gaps, (gap) =>
          Predicate.isTagged(gap, "UnexpressibleSubject") ? [gap] : []
        );

        assert.deepStrictEqual(
          Arr.map(added, ({ commands, subject }) => [subject, ...commands]),
          [["Anyone", "viewTeams"]]
        );

        const registered = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Effx.Gap))
        )(committed.gaps);

        assert.notDeepInclude(
          Arr.flatMap(registered, (gap) =>
            Predicate.isTagged(gap, "UnexpressibleSubject")
              ? [[gap.subject, ...gap.commands]]
              : []
          ),
          ["Anyone", "viewTeams"]
        );
      })
  );

  it.effect(
    "falsifier 2: each digest, the pin and the domains of the provenance are the committed files'",
    () =>
      Effect.gen(function* provenance() {
        const committed = yield* Committed;
        const { pin } = committed;

        assert.deepStrictEqual(committed.provenance.effx, {
          commit: pin.commit,
          nixpkgs: committed.provenance.effx.nixpkgs,
          repository: pin.repository,
        });
        assert.strictEqual(committed.provenance.alloy.version, pin.alloy);

        for (const [domain, entry] of Rec.toEntries(
          committed.provenance.domains
        )) {
          assert.strictEqual(
            entry.descriptionSha256,
            yield* hash(utf8(committed.texts[domain] ?? "")),
            `${domain}: description digest`
          );

          assert.strictEqual(
            entry.vectorsSha256,
            committed.vectors[domain]?.sha256,
            `${domain}: vectors digest`
          );

          assert.strictEqual(committed.vectors[domain]?.decoded.domain, domain);
        }
      })
  );

  it.effect(
    "falsifier 2, negative control: one changed character or byte is a different digest",
    () =>
      Effect.gen(function* control() {
        const committed = yield* Committed;
        const fs = yield* FileSystem.FileSystem;
        const entry = committed.provenance.domains.teams;
        const text = committed.texts.teams ?? "";

        const bytes = yield* Effect.flatMap(
          fs.readFile(vectorsFile("teams")),
          gunzip
        );

        const flipped = new Uint8Array(bytes);
        flipped.fill(((bytes[1000] ?? 0) + 1) % 256, 1000, 1001);

        assert.strictEqual(entry?.vectorsSha256, yield* hash(bytes));
        assert.notStrictEqual(
          entry?.descriptionSha256,
          yield* hash(utf8(text.replace("createTeam", "createTeams")))
        );
        assert.notStrictEqual(entry?.vectorsSha256, yield* hash(flipped));
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "falsifier 3: the kernel answers every row of every vectors file as effx's vectors say",
    () =>
      Effect.gen(function* conformance() {
        const committed = yield* Committed;

        for (const [domain, entry] of Rec.toEntries(
          committed.provenance.domains
        )) {
          const report = yield* conform(domain);

          assert.deepStrictEqual(
            report.disagreements.slice(0, 5),
            [],
            `${domain}: the kernel disagrees with the vectors`
          );
          assert.strictEqual(
            report.authorization,
            entry.rows.authorization,
            `${domain}: authorization rows compared`
          );
          assert.strictEqual(
            report.transitions,
            entry.rows.transitions,
            `${domain}: transition rows compared`
          );
          assert.isAbove(report.authorization, 0);
        }
      }),
    { timeout: 600_000 }
  );

  it.effect(
    "falsifier 3: the machines under test are the machines that the descriptions export",
    () =>
      Effect.gen(function* registry() {
        const committed = yield* Committed;

        assert.deepStrictEqual(
          Arr.dedupe(
            Arr.flatMap(committed.derived.descriptions, ({ description }) =>
              Arr.map(description.machines, ({ name }) => name)
            )
          ),
          Arr.map(machines, ({ name }) => name)
        );
      })
  );

  it.effect(
    "falsifier 3, negative controls: a grant row, a scope and a guard of the kernel's changed each fail on exactly the rows they change",
    () =>
      Effect.gen(function* controls() {
        const leaderRow = Arr.findFirst(
          GrantTable,
          (row) =>
            Arr.some(row.subjects, isLeader) &&
            Arr.contains(row.commands, "createTeam")
        );

        assert.isTrue(Option.isSome(leaderRow));

        // the Member row of viewTeams removed
        const withoutMember = yield* conform("teams", {
          table: Arr.filter(
            GrantTable,
            (row) =>
              !(
                Arr.contains(row.commands, "viewTeams") &&
                Arr.some(row.subjects, isMember)
              )
          ),
        });

        assert.isTrue(
          onlyThese(
            withoutMember,
            (row) =>
              row.kind === "authorize" &&
              row.permission === "viewTeams" &&
              !row.kernel &&
              row.effx
          )
        );

        // the leaders' scope widened from their department to all
        const widened = yield* conform("teams", {
          table: Arr.map(GrantTable, (row) =>
            Arr.some(row.subjects, isLeader) && row.scope === "department"
              ? { ...row, scope: "all" as const }
              : row
          ),
        });

        assert.isTrue(
          onlyThese(
            widened,
            (row) =>
              row.kind === "authorize" &&
              row.kernel &&
              !row.effx &&
              Option.exists(leaderRow, ({ commands }) =>
                Arr.contains(commands, row.permission)
              )
          )
        );

        // the guard of extendMembership removed
        const unguarded = yield* conform("teams", {
          machines: [
            machineUnderTest({
              context: Teams.MembershipMoment,
              table: {
                ...Teams.MembershipMachine,
                transitions: Arr.map(
                  Teams.MembershipMachine.transitions,
                  (transition) =>
                    transition.command === "extendMembership"
                      ? {
                          command: transition.command,
                          from: transition.from,
                          to: transition.to,
                        }
                      : transition
                ),
              },
            }),
          ],
        });

        assert.isTrue(
          onlyThese(
            unguarded,
            (row) =>
              (row.kind === "transition" || row.kind === "command") &&
              row.kernel &&
              !row.effx &&
              (row.transition === "extendMembership" ||
                row.transition === "Transition0_2")
          )
        );
      }),
    { timeout: 900_000 }
  );

  it.effect(
    "falsifier 3, negative control: a vectors file with no instances does not pass the row count",
    () =>
      Effect.gen(function* vacuous() {
        const committed = yield* Committed;
        Option.match(
          Option.all({
            entry: Option.fromNullishOr(
              committed.provenance.domains.organisation
            ),
            found: Option.fromNullishOr(committed.vectors.organisation),
          }),
          {
            onNone: () =>
              assert.fail(
                "the organisation vectors and provenance are committed"
              ),
            onSome: ({ entry, found }) => {
              const rows = countRows({ ...found.decoded, instances: [] }, []);

              assert.strictEqual(rows.authorization, 0);
              assert.notStrictEqual(
                rows.authorization,
                entry.rows.authorization
              );
            },
          }
        );
      })
  );
});
