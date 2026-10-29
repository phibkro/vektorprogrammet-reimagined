/**
 * Spec 0007d, falsifiers 1 to 4: the committed descriptions are the declarations' export, the committed vectors are the
 * ones that effx made from them, the kernel's `authorize` and machine tables answer every row of the vectors as they
 * say, and what effx cannot state is the committed register of gaps. Each check has a negative control that changes one
 * thing and fails.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node";
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
  String as Str,
} from "effect";

import {
  Pin,
  Provenance,
  descriptionFile,
  differences,
  directory,
  firstDifference,
  gapsFile,
  generator,
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

/** `NodeServices` carries no crypto service since Effect 4.1: the SHA-256 of the committed files comes from `NodeCrypto`. */
const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest);

/**
 * Everything committed, read once. A vectors file is gunzipped and digested when the layer is built (what the digests
 * check), and decoded on the first test that asks for it: the `teams` vectors are 175 MB of JSON, and decoding them
 * takes more than the layer's own 10 s on a shared two-CPU runner, where the tests that use the rows carry their own
 * time limit.
 */
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
      Record<
        string,
        {
          readonly decoded: Effect.Effect<VectorsFile, Schema.SchemaError>;
          readonly sha256: string;
        }
      >
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

            const decoded = yield* Effect.cached(
              Schema.decodeEffect(Schema.fromJsonString(Vectors))(
                new TextDecoder().decode(bytes)
              )
            );

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
  ).pipe(Layer.provide(services));
}

const hash = (bytes: Uint8Array) =>
  sha256Hex(bytes).pipe(Effect.provide(services));

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

  const decoded = yield* found.decoded;

  assert.strictEqual(
    decoded.domain,
    domain,
    `${domain}: the vectors file is of another domain`
  );

  return compare(decoded, {
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

const must = <A>(value: A | undefined, what: string): A =>
  value ?? assert.fail(`${what} is missing`);

/** How many disagreements of each kind a report has. */
const kinds = (report: Report): Readonly<Record<string, number>> =>
  Rec.map(
    Arr.groupBy(report.disagreements, ({ kind }): string => kind),
    (rows) => rows.length
  );

/** Non-admin people whose only viewTeams grant is the Member row. */
const memberRowsLost = (vectors: VectorsFile): number =>
  Arr.reduce(vectors.instances, 0, (sum, world) => {
    const people = new Set(
      Arr.map(
        Arr.filter(
          world.principals,
          (person) => person.kind === "Person" && !person.admin
        ),
        ({ id }) => id
      )
    );

    return (
      sum +
      Arr.filter(
        world.allows,
        ({ permission, principal }) =>
          permission === "viewTeams" && people.has(principal)
      ).length
    );
  });

/** Whether a person belongs to either subject of the leader/board grant, without a department restriction. */
const hasLeaderOrBoard = (
  world: VectorsFile["instances"][number],
  person: string
): boolean =>
  Arr.some(
    world.memberships,
    (membership) =>
      membership.active &&
      membership.person === person &&
      (membership.position === "leader" ||
        Arr.some(
          world.teams,
          (team) => team.id === membership.team && team.function === "board"
        ))
  );

/** The ungranted vector rows that the widened leader/board grant would add. */
const widenedLeaderRows = (
  vectors: VectorsFile,
  commands: readonly string[]
): number => {
  const names = new Set(Arr.map(vectors.permissions, ({ name }) => name));
  const checked = Arr.filter(commands, (command) => names.has(command));

  return Arr.reduce(vectors.instances, 0, (sum, world) => {
    const allowed = new Set(
      Arr.map(
        world.allows,
        (row) => `${row.principal}|${row.permission}|${row.target}`
      )
    );

    const people = Arr.filter(
      world.principals,
      (person) => person.kind === "Person" && hasLeaderOrBoard(world, person.id)
    );

    return (
      sum +
      Arr.reduce(
        people,
        0,
        (byPerson, person) =>
          byPerson +
          Arr.reduce(
            world.targets,
            0,
            (byTarget, target) =>
              byTarget +
              Arr.filter(
                checked,
                (command) =>
                  !allowed.has(`${person.id}|${command}|${target.id}`)
              ).length
          )
      )
    );
  });
};

/** One eligible Active row for each context and phase in which effx did not enable the transition. */
const disabledActiveRows = (vectors: VectorsFile, name: string): number =>
  Arr.reduce(
    vectors.instances,
    0,
    (sum, world) =>
      sum +
      Arr.reduce(world.contexts, 0, (byContext, context) => {
        if (context.machine !== "Membership") {
          return byContext;
        }

        return (
          byContext +
          Arr.reduce(["atNow", "afterTick"] as const, 0, (byPhase, phase) => {
            if (
              phase === "afterTick" &&
              (world.clock === null || world.clock.afterTick === null)
            ) {
              return byPhase;
            }

            const enabled = Arr.some(
              world.enabled[phase],
              (row) =>
                row.machine === "Membership" &&
                row.state === "Active" &&
                row.context === context.id &&
                row.transition === name
            );

            return byPhase + Number(!enabled);
          })
        );
      })
  );

/**
 * What differs between the committed descriptions and the export: a line for each domain whose text differs, naming
 * the domain and the first line that does. The check and its negative controls both ask this.
 */
const drift = (
  committed: Readonly<Record<string, string>>,
  exported: readonly { readonly domain: string; readonly text: string }[]
): readonly string[] =>
  Arr.flatMap(exported, ({ domain, text }) =>
    Option.match(firstDifference(committed[domain] ?? "", text), {
      onNone: () => [],
      onSome: ({ have, line, want }) => [
        `${domain}: line ${line} of the committed description is ${JSON.stringify(have)}, the export says ${JSON.stringify(want)}`,
      ],
    })
  );

/**
 * What differs between the generator that a provenance records and the one that the tool makes the vectors with: the
 * first line at which the two part, empty when they are the same. The check and its negative controls both ask this.
 */
const generatorDrift = (
  recorded: ProvenanceFile["generator"]
): readonly string[] =>
  Option.match(
    firstDifference(
      JSON.stringify(recorded, null, 2),
      JSON.stringify(generator, null, 2)
    ),
    {
      onNone: () => [],
      onSome: ({ have, line, want }) => [
        `line ${line} of the recorded generator is ${JSON.stringify(have)}, the tool's is ${JSON.stringify(want)}`,
      ],
    }
  );

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
          accounts: Str.replace(
            "createAccount",
            "createAccounts"
          )(committed.texts.accounts ?? ""),
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
        }
      })
  );

  it.effect(
    "falsifier 2, negative control: one changed character or byte is a different digest",
    () =>
      Effect.gen(function* control() {
        const committed = yield* Committed;
        const fs = yield* FileSystem.FileSystem;
        const entry = committed.provenance.domains.audit;
        const text = committed.texts.teams ?? "";

        // The smallest vectors file stands for the others: any changed byte changes any digest. The teams file is 175 MB.
        const bytes = yield* Effect.flatMap(
          fs.readFile(vectorsFile("audit")),
          gunzip
        );

        const flipped = new Uint8Array(bytes);
        flipped.fill(((bytes[1000] ?? 0) + 1) % 256, 1000, 1001);

        assert.strictEqual(entry?.vectorsSha256, yield* hash(bytes));
        assert.notStrictEqual(
          committed.provenance.domains.teams?.descriptionSha256,
          yield* hash(utf8(Str.replace("createTeam", "createTeams")(text)))
        );
        assert.notStrictEqual(entry?.vectorsSha256, yield* hash(flipped));
      }).pipe(Effect.provide(services))
  );

  it.effect(
    "falsifier 9: the provenance records the way that this tool makes the vectors",
    () =>
      Effect.gen(function* recorded() {
        const committed = yield* Committed;

        assert.deepStrictEqual(
          generatorDrift(committed.provenance.generator),
          [],
          "the provenance records another way of making the vectors than this tool's: make them again"
        );
      })
  );

  it.effect(
    "falsifier 9, negative control: a provenance that records another config, command, link or file set fails the same comparison",
    () =>
      Effect.gen(function* control() {
        const { generator: recorded } = (yield* Committed).provenance;

        const config = must(
          recorded.project["effx.config.ts"],
          "the config of the recorded generator"
        );

        // the comparison is silent for the recorded generator, so what it says below is its own
        assert.deepStrictEqual(generatorDrift(recorded), []);

        const other = {
          "another command": {
            ...recorded,
            commands: Arr.map(recorded.commands, (argv) =>
              Arr.filter(argv, (part) => part !== "check")
            ),
          },
          "another config": {
            ...recorded,
            project: {
              ...recorded.project,
              "effx.config.ts": Str.replace(
                "alloy: true",
                "alloy: false"
              )(config),
            },
          },
          "another link": {
            ...recorded,
            links: { node_modules: "<effx>/lib" },
          },
          "one file less": {
            ...recorded,
            project: Rec.remove(recorded.project, "entry.ts"),
          },
        };

        for (const [change, generated] of Rec.toEntries(other)) {
          assert.lengthOf(generatorDrift(generated), 1, change);
        }
      })
  );

  it.effect(
    "gate G2: the drift check is silent for what is committed, and names the domain and the line of what effx made differently",
    () =>
      Effect.gen(function* check() {
        const { domains } = (yield* Committed).provenance;
        const teams = must(domains.teams, "the teams provenance");

        assert.deepStrictEqual(yield* differences(domains, domains), []);

        const other = yield* differences(domains, {
          ...domains,
          teams: { ...teams, vectorsSha256: Str.repeat(64)("0") },
        });

        assert.lengthOf(other, 1);
        assert.match(
          other[0] ?? "",
          /^teams: line \d+ of its committed provenance is ".*vectorsSha256.*", effx made ".*vectorsSha256/u
        );

        const failing = yield* differences(domains, {
          ...domains,
          teams: {
            ...teams,
            assertions: Arr.map(teams.assertions, (assertion) => ({
              ...assertion,
              result:
                assertion.result === "PASS"
                  ? ("NOT APPLICABLE" as const)
                  : ("PASS" as const),
            })),
          },
        });

        assert.lengthOf(failing, 1);

        assert.deepStrictEqual(
          yield* differences(domains, Rec.remove(domains, "teams")),
          ["teams: effx made no vectors for a committed domain"]
        );

        assert.deepStrictEqual(
          yield* differences(Rec.remove(domains, "teams"), domains),
          ["teams: effx made vectors for a domain with none committed"]
        );
      })
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
          assert.strictEqual(
            report.commands,
            entry.rows.commands,
            `${domain}: command rows compared`
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
    "falsifier 3, negative controls: a grant row, a scope, a guard and a change of time of the kernel's changed each fail on exactly the rows they change",
    () =>
      Effect.gen(function* controls() {
        const leaderRow = Arr.findFirst(
          GrantTable,
          (row) =>
            Arr.some(row.subjects, isLeader) &&
            Arr.contains(row.commands, "createTeam")
        );

        const leaderCommands = Option.match(leaderRow, {
          onNone: () => assert.fail("leader grant is missing"),
          onSome: ({ commands }) => commands,
        });

        const committed = yield* Committed;

        const vectors = yield* must(committed.vectors.teams, "teams vectors")
          .decoded;

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

        // the `viewTeams` rows that only the removed row granted
        assert.deepStrictEqual(kinds(withoutMember), {
          authorize: memberRowsLost(vectors),
        });

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
              Arr.contains(leaderCommands, row.permission)
          )
        );

        // the rows of the leaders' commands that the wider scope grants and the vectors do not
        assert.deepStrictEqual(kinds(widened), {
          authorize: widenedLeaderRows(vectors, leaderCommands),
        });

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

        // each row of state Active where the guard was false is both a transition row and a `Machine.can` row
        const unguardedRows = disabledActiveRows(vectors, "Transition0_2");
        assert.deepStrictEqual(kinds(unguarded), {
          command: unguardedRows,
          transition: unguardedRows,
        });

        // the end that has passed no longer has to have passed: the guard of the change to Ended removed
        const alwaysEnds = yield* conform("teams", {
          machines: [
            machineUnderTest({
              context: Teams.MembershipMoment,
              table: {
                ...Teams.MembershipMachine,
                calculated: Arr.map(
                  Teams.MembershipMachine.calculated,
                  (change) =>
                    change.to === "Ended"
                      ? { ...change, accepts: () => true }
                      : change
                ),
              },
            }),
          ],
        });

        assert.isTrue(
          onlyThese(
            alwaysEnds,
            (row) =>
              row.kind === "transition" &&
              row.kernel &&
              !row.effx &&
              row.state === "Active" &&
              row.transition === "Transition0_9"
          )
        );

        // each row of state Active where the end has not passed
        assert.deepStrictEqual(kinds(alwaysEnds), {
          transition: disabledActiveRows(vectors, "Transition0_9"),
        });

        // a table without its changes of time disagrees with nothing and compares fewer rows than the file asks for

        const ignoring = yield* conform("teams", {
          machines: [
            machineUnderTest({
              context: Teams.MembershipMoment,
              table: { ...Teams.MembershipMachine, calculated: [] },
            }),
          ],
        });

        assert.deepStrictEqual(ignoring.disagreements, []);

        // each of the machine's transitions is asked the same number of rows, so the two that time makes are missing
        const perTransition =
          ignoring.transitions / Teams.MembershipMachine.transitions.length;

        assert.strictEqual(
          committed.provenance.domains.teams?.rows.transitions,
          ignoring.transitions +
            Teams.MembershipMachine.calculated.length * perTransition
        );
      }),
    { timeout: 900_000 }
  );

  it.effect(
    "falsifier 3, negative control: a vectors file with no instances does not pass the row count",
    () =>
      Effect.gen(function* vacuous() {
        const committed = yield* Committed;
        yield* Option.match(
          Option.all({
            entry: Option.fromNullishOr(
              committed.provenance.domains.organisation
            ),
            found: Option.fromNullishOr(committed.vectors.organisation),
          }),
          {
            onNone: () =>
              Effect.sync(() =>
                assert.fail(
                  "the organisation vectors and provenance are committed"
                )
              ),
            onSome: ({ entry, found }) =>
              Effect.gen(function* rows() {
                const decoded = yield* found.decoded;
                const counted = countRows({ ...decoded, instances: [] }, []);

                assert.strictEqual(counted.authorization, 0);
                assert.notStrictEqual(
                  counted.authorization,
                  entry.rows.authorization
                );
              }),
          }
        );
      })
  );
});
