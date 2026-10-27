/**
 * Issue 15: a principal without a page's read gets no 2xx for the page or its data. Mats Medlem, a plain team member,
 * holds no `viewPeople`: the sidebar hides Personer, and the page used to answer 200 with an empty list.
 *
 * The rule: a control-panel read is served exactly when the principal may open the page's section, which is the
 * predicate the sidebar uses (`panelAccess.ts`, one declaration); otherwise it answers 403 (`Forbidden`, the refusal
 * an anonymous principal gets), before any row is read. The rows a served page lists stay filtered by `authorize`.
 *
 * The falsifier runs every read server function (`panelReads`) as every kind of principal over the in-memory world
 * and compares the status with the sidebar. The negative controls take the guard off one read at a time: each must
 * make the falsifier fail, so it can tell a guarded read from an unguarded one. The browser tests
 * (`e2e/shell.spec.ts`) send the same requests over HTTP.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  DepartmentId,
  PrincipalDirectory,
  SystemJob,
  TeamFunction,
  anonymous,
  authorize,
  currentSemester,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Order,
  DateTime,
  Effect,
  Option,
  Predicate,
  Record as Rec,
} from "effect";

import type { Outcome } from "../src/lib/outcome";
import { PANEL_SECTIONS, sectionOfPath } from "../src/lib/panelSections";
import type { SectionKey } from "../src/lib/panelSections";
import type { RequestError } from "../src/server/errors";
import { integrationsView } from "../src/server/integrations";
import {
  dashboardView,
  departmentsView,
  fieldsOfStudyView,
  semestersView,
  socialEventsView,
} from "../src/server/panel";
import { READ_SECTIONS } from "../src/server/panelAccess";
import type { PanelRead } from "../src/server/panelAccess";
import { panelReads } from "../src/server/panelReads";
import {
  adminsView,
  peopleView,
  teamView,
  teamsView,
} from "../src/server/teams";
import { makeTables } from "./support/memory";
import type { MemoryTables } from "./support/memory";
import { assertRefused, assertSuccess } from "./support/outcomes";
import { ADMIN, WITHOUT_TEAM, leaderOf, memberOf } from "./support/principals";
import { viewAs } from "./support/run";
import type { ViewServices } from "./support/run";
import { sectionsOf } from "./support/sidebar";
import {
  BERGEN,
  BERGEN_TEAM,
  PEOPLE,
  TRONDHEIM,
  TRONDHEIM_TEAM,
  worldAt,
} from "./support/teamWorld";

const MISSING_TEAM = 999;

const freshWorld = Effect.suspend(() => worldAt(makeTables()));

/** A read as a server function runs it: the page's data for a team id (only `getTeam` reads it). */
type Call = (
  teamId: number
) => Effect.Effect<unknown, RequestError, ViewServices>;

type Calls = Readonly<Record<PanelRead, Call>>;

const asCall = (
  read: Effect.Effect<unknown, RequestError, ViewServices> | Call
): Call => (Predicate.isFunction(read) ? read : () => read);

/** What the server functions run. */
const GUARDED: Calls = Rec.map(panelReads, asCall);

/** The views the guard wraps, bare: what a route without its guard would run. */
const BARE: Calls = {
  getAdmins: () => adminsView,
  getDashboard: () => dashboardView,
  getDepartments: () => departmentsView,
  getFieldsOfStudy: () => fieldsOfStudyView,
  getIntegrations: () => integrationsView,
  getPeople: () => peopleView,
  getSemesters: () => semestersView,
  getSocialEvents: () => socialEventsView,
  getTeam: (id) => teamView(id),
  getTeams: () => teamsView,
};

const READS = Rec.keys(READ_SECTIONS);

/** The declaration looked up by the name a route's source gives. */
const SECTIONS_OF_READS: Readonly<Record<string, SectionKey>> = READ_SECTIONS;

// ---------------------------------------------------------------- principals

/** Every function's member and leader in the first department, and a leader of the second. */
const synthetic: readonly (readonly [string, Principal])[] = [
  ["anonymous", anonymous],
  ...Arr.map(
    SystemJob.literals,
    (job) => [`System(${job})`, systemPrincipal(job)] as const
  ),
  ["administrator", ADMIN],
  ["person with no membership", WITHOUT_TEAM],
  ["leader of the other department", leaderOf(BERGEN)],
  ...Arr.flatMap(TeamFunction.literals, (teamFunction) => [
    [
      `member of a ${teamFunction} team`,
      memberOf(TRONDHEIM, { function: teamFunction }),
    ] as const,
    [
      `leader of a ${teamFunction} team`,
      memberOf(TRONDHEIM, { function: teamFunction, leader: true }),
    ] as const,
  ]),
];

/** The world's people as `PrincipalDirectory` loads them, memberships in every state included. */
const WORLD_PEOPLE = [
  ["Ada Admin", "administrator by the admin list"],
  ["Bjorn Bergen", "member in the other department"],
  ["Eva Ekstern", "ended membership"],
  ["Lise Leder", "leader"],
  ["Mats Medlem", "plain member"],
  ["Nora Neste", "membership not begun"],
] as const;

const loaded = (tables: MemoryTables, name: string) =>
  Effect.map(
    viewAs(
      tables,
      anonymous,
      Effect.gen(function* loadPrincipal() {
        const directory = yield* PrincipalDirectory;

        return yield* directory.byName(name, {
          current: yield* currentSemester,
          now: yield* DateTime.now,
        });
      })
    ),
    (outcome) =>
      Option.match(assertSuccess(outcome), {
        onNone: () => assert.fail(`${name} is in the world`),
        onSome: (principal): Principal => principal,
      })
  );

const principalsOf = (tables: MemoryTables) =>
  Effect.map(
    Effect.forEach(WORLD_PEOPLE, ([name, label]) =>
      Effect.map(
        loaded(tables, name),
        (principal) => [`${name} (${label})`, principal] as const
      )
    ),
    (people) => [...synthetic, ...people]
  );

// ---------------------------------------------------------------- the falsifier

const statusOf = (outcome: Outcome<unknown>): number =>
  Predicate.isTagged(outcome, "Success") ? 200 : outcome.status;

const is2xx = (status: number): boolean => status >= 200 && status < 300;

/** One request of the matrix: a read, and for `getTeam` the team it asks for and that team's department (none for a team that is not there). */
interface Ask {
  readonly read: PanelRead;
  readonly teamId: number;
  readonly departmentId: number | null;
}

const ASKS: readonly Ask[] = Arr.flatMap(READS, (read): readonly Ask[] =>
  read === "getTeam"
    ? [
        { departmentId: TRONDHEIM, read, teamId: TRONDHEIM_TEAM },
        { departmentId: BERGEN, read, teamId: BERGEN_TEAM },
        { departmentId: null, read, teamId: MISSING_TEAM },
      ]
    : [{ departmentId: null, read, teamId: TRONDHEIM_TEAM }]
);

/**
 * The status the rule demands: 403 when the sidebar hides the read's section, even for a team that does not exist.
 * For a section the principal may open, `getTeam` is still decided by the team's own department (a row-level
 * `viewTeams`, underneath) and a team that is not there is a 404; every other read is served.
 */
const expectedStatus = (
  principal: Principal,
  sidebar: boolean,
  ask: Ask
): number => {
  if (!sidebar) {
    return 403;
  }

  if (ask.departmentId === null) {
    return ask.read === "getTeam" ? 404 : 200;
  }

  return authorize(principal, "viewTeams", {
    departmentId: DepartmentId.make(ask.departmentId),
  })
    ? 200
    : 403;
};

interface Answer {
  readonly label: string;
  readonly ask: Ask;
  readonly sidebar: boolean;
  readonly status: number;
  readonly expected: number;
}

const agrees = ({ expected, status }: Answer): boolean =>
  is2xx(expected) ? is2xx(status) : status === expected;

const describeAnswer = ({ ask, expected, label, sidebar, status }: Answer) =>
  `${label}: ${ask.read}${ask.read === "getTeam" ? `(${ask.teamId})` : ""} answered ${status}, expected ${expected}, ` +
  `the sidebar ${sidebar ? "shows" : "hides"} ${READ_SECTIONS[ask.read]}`;

/** Every read of `calls` as every principal, with the status the rule demands next to the status it got. */
const answersOf = (tables: MemoryTables, calls: Calls) =>
  Effect.gen(function* answersOfReads() {
    const principals = yield* principalsOf(tables);

    return yield* Effect.forEach(
      Arr.flatMap(principals, ([label, principal]) =>
        Arr.map(ASKS, (ask) => [label, principal, ask] as const)
      ),
      ([label, principal, ask]) =>
        Effect.map(
          viewAs(tables, principal, calls[ask.read](ask.teamId)),
          (outcome): Answer => {
            const sidebar = sectionsOf(principal).includes(
              READ_SECTIONS[ask.read]
            );

            return {
              ask,
              expected: expectedStatus(principal, sidebar, ask),
              label,
              sidebar,
              status: statusOf(outcome),
            };
          }
        )
    );
  });

/** Every way the reads of `calls` disagree with the sidebar, as sentences. */
const violationsOf = (tables: MemoryTables, calls: Calls) =>
  Effect.map(answersOf(tables, calls), (answers) =>
    Arr.map(
      Arr.filter(answers, (answer) => !agrees(answer)),
      describeAnswer
    )
  );

describe("issue 15: a principal without the read gets no 2xx", () => {
  it.effect(
    "every control-panel read answers 2xx exactly when the sidebar shows its section, and 403 otherwise, for every kind of principal",
    () =>
      Effect.gen(function* falsifier() {
        const tables = yield* freshWorld;
        const answers = yield* answersOf(tables, GUARDED);

        assert.deepStrictEqual(
          Arr.map(
            Arr.filter(answers, (answer) => !agrees(answer)),
            describeAnswer
          ),
          []
        );

        // Not vacuous: every read is served to somebody and refused to somebody.
        for (const read of READS) {
          const own = Arr.filter(answers, (answer) => answer.ask.read === read);

          assert.isTrue(
            Arr.some(own, (answer) => is2xx(answer.status)),
            `${read} is served`
          );
          assert.isTrue(
            Arr.some(own, (answer) => answer.status === 403),
            `${read} is refused`
          );
        }
      })
  );

  it.effect(
    "negative control: a read without its guard is caught, whichever read it is (the falsifier can tell)",
    () =>
      Effect.gen(function* negativeControl() {
        const tables = yield* freshWorld;

        for (const read of READS) {
          const violations = yield* violationsOf(tables, {
            ...GUARDED,
            [read]: BARE[read],
          });

          assert.isTrue(
            Arr.some(violations, (violation) =>
              violation.includes(`: ${read}`)
            ),
            `${read} without its guard fails the falsifier`
          );
        }
      })
  );

  it.effect(
    "the people page: a member without viewPeople is refused with 403, not served an empty list; a leader is served",
    () =>
      Effect.gen(function* peoplePage() {
        const tables = yield* freshWorld;
        const mats = yield* loaded(tables, "Mats Medlem");
        const lise = yield* loaded(tables, "Lise Leder");

        assert.isFalse(
          authorize(mats, "viewPeople", {
            departmentId: DepartmentId.make(TRONDHEIM),
          })
        );
        assertRefused(
          yield* viewAs(tables, mats, panelReads.getPeople),
          "Forbidden"
        );

        const served = assertSuccess(
          yield* viewAs(tables, lise, panelReads.getPeople)
        );

        assert.isAbove(served.people.length, 0);
        assert.isTrue(
          Arr.some(served.people, (person) => person.id === PEOPLE.mats)
        );
      })
  );

  it.effect(
    "a refused read is the refusal an anonymous principal gets: 403 Forbidden, with the same message",
    () =>
      Effect.gen(function* sameRefusal() {
        const tables = yield* freshWorld;
        const mats = yield* loaded(tables, "Mats Medlem");

        const refusal = assertRefused(
          yield* viewAs(tables, mats, panelReads.getPeople),
          "Forbidden"
        );

        const anonymousRefusal = assertRefused(
          yield* viewAs(tables, anonymous, panelReads.getDashboard),
          "Forbidden"
        );

        assert.strictEqual(refusal.status, 403);
        assert.strictEqual(refusal.message, anonymousRefusal.message);
      })
  );
});

// ---------------------------------------------------------------- the wiring

/** Every source file of the app, as text: the wiring is checked against the server functions and the route loaders. */
const SOURCES = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
});

const sourceOf = (path: string): string =>
  Option.match(Rec.get(SOURCES, `../src/${path}`), {
    onNone: () => assert.fail(`${path} is in the source`),
    onSome: (source) => source,
  });

/** The address of the page a route file renders, a team id standing in for `$teamId`. */
const pathOfRouteFile = (file: string): string =>
  `/kontrollpanel${file
    .replace("routes/kontrollpanel", "")
    .replace(/\.tsx$/u, "")
    .replace(/\/?index$/u, "")
    .replace("$teamId", "1")}`;

/** The control panel's pages: every route file below `/kontrollpanel`, but the layout (the shell). */
const PANEL_ROUTE_FILES = Arr.filter(
  Arr.map(Rec.keys(SOURCES), (key) => key.replace("../src/", "")),
  (file) =>
    file.startsWith("routes/kontrollpanel/") &&
    file !== "routes/kontrollpanel/route.tsx"
);

/** The read server function a route's loader calls. */
const loaderRead = (file: string): string =>
  /loader:[^;]*?\b(?<name>get[A-Z]\w*)\(/u.exec(sourceOf(file))?.groups?.name ??
  "";

const sectionOfFile = (file: string) => sectionOfPath(pathOfRouteFile(file));

describe("issue 15: every page and read function is under the one declaration", () => {
  it("the GET server functions of the control panel are the shell (the sidebar itself) and exactly the reads of READ_SECTIONS, each run as `panelReads.<name>`", () => {
    const source = sourceOf("functions/panel.functions.ts");

    const getters = Arr.map(
      Arr.fromIterable(
        source.matchAll(
          /export const (?<name>\w+) = createServerFn\(\{ method: "GET" \}\)/gu
        )
      ),
      (match) => match.groups?.name ?? ""
    );

    assert.deepStrictEqual(
      Arr.sort(getters, Order.String),
      Arr.sort(["getShell", ...READS], Order.String)
    );

    for (const read of READS) {
      assert.include(source, `panelReads.${read}`, read);
    }

    // No read server function runs a view of its own: every `runQuery(requestScope(context), …)` runs a guarded read.
    const programs = Arr.map(
      Arr.fromIterable(
        source.matchAll(
          /runQuery\(\s*requestScope\(context\),\s*(?<program>[\w.]+)/gu
        )
      ),
      (match) => match.groups?.program ?? ""
    );

    assert.strictEqual(programs.length, READS.length);

    for (const program of programs) {
      assert.isTrue(program.startsWith("panelReads."), program);
    }
  });

  it("every control-panel page belongs to a section of the sidebar, and its loader calls a read of that section", () => {
    assert.isAbove(PANEL_ROUTE_FILES.length, 0);

    for (const file of PANEL_ROUTE_FILES) {
      const read = loaderRead(file);

      assert.isDefined(sectionOfFile(file), `${file} is a section's page`);
      assert.deepStrictEqual(
        Rec.get(SECTIONS_OF_READS, read),
        Option.fromNullishOr(sectionOfFile(file)?.key),
        `${file}: ${read} is the read of the page's section`
      );
    }

    for (const section of PANEL_SECTIONS) {
      assert.isTrue(
        Arr.some(
          PANEL_ROUTE_FILES,
          (file) => sectionOfFile(file)?.key === section.key
        ),
        `${section.key} has a page`
      );
    }
  });
});
