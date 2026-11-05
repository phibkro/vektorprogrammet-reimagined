/**
 * Spec 0003, falsifier 3: every public and control-panel read path succeeds against a database role that
 * holds SELECT and nothing else, so no read writes.
 *
 * Each read program a server function (or the Worker entry) runs through `runQuery` is run, once per principal
 * (anonymous, admin, team leader, team member, a person with no team), over `DatabaseLive` connected as the SELECT-only role of a migrated
 * disposable PostgreSQL database. It runs twice: on empty tables (no
 * semester row yet: the state in which the retired `ensureCurrentSemester` inserted from three loaders) and
 * on seeded tables. A write is refused with `permission denied`, which `DatabaseLive` turns into a defect, so
 * any defect fails the test. The role itself is proven to read and to refuse every kind of write in
 * the read-only role test; the negative controls here run a write through the same
 * harness.
 *
 * Every registered read is exercised against actual database privileges; no source-text assertions.
 */
import { assert, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";
import type { Context, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { ContentLive } from "../src/adapters/db/content";
import { DatabaseLive } from "../src/adapters/db/databaseLive";
import type { Forbidden, NotFound, ValidationFailed } from "../src/core/errors";
import { FieldOfStudyId, PersonId, PositionId } from "../src/core/ids";
import {
  CurrentPrincipal,
  Principal,
  anonymous,
  systemPrincipal,
} from "../src/core/kernel/principal";
import {
  AggregateLocks,
  lockAdminList,
} from "../src/core/transactions/aggregate";
import { Transactor } from "../src/core/transactions/transactor";
import { EmailAddress } from "../src/core/validation";
import {
  myPage,
  signInDestination,
} from "../src/features/accounts/server/accounts";
import {
  applicationPage,
  applyIndexPage,
} from "../src/features/admission/server/admission";
import type {
  CmsClient,
  CmsFailure,
  ContentEditor,
} from "../src/features/cms/domain/client";
import { servePublicFile } from "../src/features/files/domain/commands";
import { FileStore } from "../src/features/files/domain/services";
import {
  currentSemester,
  semesterJob,
} from "../src/features/organisation/domain/commands";
import {
  FieldOfStudyRepository,
  SemesterRepository,
} from "../src/features/organisation/domain/services";
import { panelReads } from "../src/features/panel/server/reads";
import { shellView } from "../src/features/panel/server/shell";
import {
  aboutPage,
  articlePage,
  assistantsPage,
  contactPage,
  departmentSlugById,
  footerSponsors,
  homePage,
  newsPage,
  parentsPage,
  schoolsPage,
  teamPage,
} from "../src/features/site/server/pages";
import {
  AdminGrantRepository,
  MembershipRepository,
  PersonRepository,
  PrincipalDirectory,
  TeamRepository,
} from "../src/features/teams/domain/services";
import { WorkspaceFacts } from "../src/features/workspace/domain/services";
import { isolationReport } from "../src/server/diagnostics/isolation";
import { legacyFileLocation } from "../src/server/http/redirects";
import { Auth } from "../src/server/identity/auth";
import { resolvePrincipal } from "../src/server/identity/principal";
import type { DatabaseServices } from "../src/server/services";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "./db/support/disposableDatabase";
import { ReadOnlyDatabaseUrl, readOnlyRole } from "./db/support/readOnlyRole";
import { draft, memoryCms, paragraph, published, textsOf } from "./support/cms";
import type { CmsSeed } from "./support/cms";
import { ADMIN, WITHOUT_TEAM, leaderOf, memberOf } from "./support/principals";

type ReadServices =
  | CmsClient
  | ContentEditor
  | DatabaseServices
  | CurrentPrincipal
  | FileStore
  | Auth;

/** What a read path answers: a value, the typed `NotFound` that a missing row means, or the typed `Forbidden` of its own grant check. */
type Expected = "ok" | "NotFound" | "Forbidden";

interface ReadPath {
  /** The server function (or entry point) that runs it. */
  readonly site: string;
  readonly program: Effect.Effect<
    unknown,
    CmsFailure | Forbidden | NotFound | ValidationFailed,
    ReadServices
  >;
  readonly empty: Expected;
  readonly seeded: Expected;
  /** The principals whose grant check this path fails (typed, before any read) where it would otherwise answer. */
  readonly refusedTo: readonly string[];
}

const readPath = (
  site: string,
  program: ReadPath["program"],
  expected: Partial<Pick<ReadPath, "empty" | "refusedTo" | "seeded">> = {}
): ReadPath => ({
  empty: "ok",
  refusedTo: [],
  seeded: "ok",
  ...expected,
  program,
  site,
});

/** The CMS stand-in: empty with the tables, and an article, a draft, a sponsor and a text once they are seeded. */
const CMS_SEEDS = {
  empty: {},
  seeded: {
    news: [
      published("opptak-apner", {
        content: paragraph("Søk nå"),
        sticky: true,
        title: "Opptak åpner",
      }),
      draft("utkast", { title: "Utkast" }),
    ],
    sponsors: [
      published("sponsor", {
        name: "Sponsor",
        size: "medium",
        url: "https://example.org",
      }),
    ],
    texts: textsOf({ "home-tagline": paragraph("Hei") }),
  },
} satisfies Record<"empty" | "seeded", Partial<CmsSeed>>;

const KEY_SMALL = `${"a".repeat(64)}.png`;
const LEGACY_PATH = "Offentlige filer/logo.png";
const TEAM_ID = 1;
const LOCAL_PERSON = "Lise Leder";

/** Who the control panel's overview, semesters, teams and events refuse: nobody signed in, and a person with no team and no admin place. */
const NO_PANEL = ["anonymous", "person without team"];

/** Who the departments, the fields of study and the people also refuse: a plain team member holds none of their commands or reads. */
const NO_MANAGEMENT = [...NO_PANEL, "team member"];

/** Who `createAdminGrant` refuses: everyone but an administrator. */
const NOT_ADMIN = [
  "anonymous",
  "team leader",
  "team member",
  "person without team",
];

/** The projection facts are reads even when no report has been requested. */
const workspaceInputs = Effect.gen(function* projectionInputs() {
  const facts = yield* WorkspaceFacts;
  const semester = yield* currentSemester;
  yield* facts.departments;
  yield* facts.departmentEngagements(semester);
  yield* facts.people(semester);
  yield* facts.storedAddresses;
  yield* facts.configuredGroupAddresses;
  yield* facts.teamsAfter(semester, null, 10);
});

/** Every `runQuery` call site of the app, by the server function or entry point that holds it. */
const READ_PATHS: readonly ReadPath[] = [
  readPath("public.functions getHomePage", homePage),
  readPath("public.functions getAboutPage", aboutPage),
  readPath("public.functions getAssistantsPage", assistantsPage),
  readPath("public.functions getTeamPage", teamPage(null)),
  readPath("public.functions getTeamPage (department)", teamPage("alfaby"), {
    empty: "NotFound",
  }),
  readPath("public.functions getParentsPage", parentsPage),
  readPath("public.functions getSchoolsPage", schoolsPage),
  readPath(
    "public.functions getNewsPage",
    newsPage({ department: null, page: 1 })
  ),
  readPath(
    "public.functions getNewsPage (department)",
    newsPage({ department: "alfa", page: 1 })
  ),
  readPath("public.functions getArticlePage", articlePage("opptak-apner"), {
    empty: "NotFound",
  }),
  readPath("public.functions getArticlePage (draft)", articlePage("utkast"), {
    empty: "NotFound",
    seeded: "NotFound",
  }),
  readPath("public.functions getFooter", footerSponsors),
  readPath("public.functions getContactPage", contactPage(null, false), {
    empty: "NotFound",
  }),
  readPath(
    "public.functions getContactPage (receipt)",
    contactPage("alfaby", true),
    { empty: "NotFound" }
  ),
  readPath("public.functions getDepartmentSlug", departmentSlugById(1), {
    empty: "NotFound",
  }),
  readPath("panel.functions getContent", panelReads.getContent, {
    refusedTo: NOT_ADMIN,
  }),
  readPath("public.functions getApplyIndex", applyIndexPage),
  readPath(
    "public.functions getApplicationPage",
    applicationPage("alfaby", false),
    { empty: "NotFound" }
  ),
  readPath(
    "public.functions getApplicationPage (receipt)",
    applicationPage("alfaby", true),
    { empty: "NotFound" }
  ),
  readPath("panel.functions getShell", shellView),
  readPath("panel.functions getAdmission", panelReads.getAdmission, {
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getDashboard", panelReads.getDashboard, {
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getDepartments", panelReads.getDepartments, {
    refusedTo: NO_MANAGEMENT,
  }),
  readPath("panel.functions getSemesters", panelReads.getSemesters, {
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getFieldsOfStudy", panelReads.getFieldsOfStudy, {
    refusedTo: NO_MANAGEMENT,
  }),
  readPath("panel.functions getSocialEvents", panelReads.getSocialEvents, {
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getTeams", panelReads.getTeams, {
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getTeam", panelReads.getTeam(TEAM_ID), {
    empty: "NotFound",
    refusedTo: NO_PANEL,
  }),
  readPath("panel.functions getPeople", panelReads.getPeople, {
    refusedTo: NO_MANAGEMENT,
  }),
  readPath("panel.functions getAdmins", panelReads.getAdmins, {
    refusedTo: NOT_ADMIN,
  }),
  readPath("panel.functions getIntegrations", panelReads.getIntegrations, {
    refusedTo: NOT_ADMIN,
  }),
  readPath("panel.functions getImpact", panelReads.getImpact, {
    refusedTo: NOT_ADMIN,
  }),
  readPath("WorkspaceFacts projection inputs", workspaceInputs),
  readPath("account.functions getSignInDestination", signInDestination),
  readPath(
    "account.functions getMyPage (signed in)",
    myPage.pipe(
      Effect.provideService(
        CurrentPrincipal,
        Principal.cases.Person.make({
          memberships: [],
          personId: PersonId.make(1),
        })
      )
    ),
    { empty: "NotFound" }
  ),
  readPath(
    "account.functions getMyPage (anonymous)",
    myPage.pipe(Effect.provideService(CurrentPrincipal, anonymous))
  ),
  readPath(
    "server/runtime liveRequestLayer: the principal's facts",
    resolvePrincipal(new Headers())
  ),
  readPath(
    "server/principal active account and memberships",
    Effect.gen(function* activePrincipalRead() {
      const directory = yield* PrincipalDirectory;

      return yield* directory.activeById(PersonId.make(1), {
        current: yield* currentSemester,
        now: yield* DateTime.now,
      });
    })
  ),
  readPath("routes/filer/$key GET", servePublicFile(KEY_SMALL), {
    empty: "NotFound",
  }),
  readPath("routes/api/isolation GET", isolationReport("preview")),
  readPath("server.ts legacy file redirect", legacyFileLocation(LEGACY_PATH)),
];

const ACTORS: readonly (readonly [string, Principal])[] = [
  ["anonymous", anonymous],
  ["admin", ADMIN],
  ["team leader", leaderOf(1)],
  ["team member", memberOf(1)],
  ["person without team", WITHOUT_TEAM],
];

/** R2 answers every key; whether the key is registered is the database's call. */
const fileStore = Layer.succeed(
  FileStore,
  FileStore.of({
    get: () => Effect.succeedSome({ body: Stream.empty, size: 0 }),
    put: () => Effect.void,
  })
);

/** The services of one request: `DatabaseLive` as the role behind `url`, and an R2 stand-in. */
const requestServices = (url: Redacted.Redacted) =>
  Layer.mergeAll(
    ContentLive,
    fileStore,
    Layer.mock(Auth, {
      session: () => Effect.succeed({ cookiePresent: false, personId: null }),
    })
  ).pipe(
    Layer.provideMerge(DatabaseLive({ maxConnections: 2, url })),
    Layer.orDie
  );

/** The fixture: a department with a field of study, and a file. */
const SEED = [
  `insert into public_file (key, sha256, content_type, name, size, uploaded_at, legacy_path) values
     ('${KEY_SMALL}', '${"a".repeat(64)}', 'image/png', 'liten.png', 1, now(), '${LEGACY_PATH}')`,
  `insert into department (id, city, email, name, short_name, active, logo_key) values
     (1, 'Alfaby', 'kontakt@alfa.example', 'Avdeling Alfa', 'ALFA', true, '${KEY_SMALL}'),
     (2, 'Betaby', 'kontakt@beta.example', 'Avdeling Beta', 'BETA', false, null)`,
  `insert into field_of_study (department_id, name, short_name) values (1, 'Fag Alfa', 'FA')`,
  `insert into site_content (collection, slug, draft) values ('texts', 'read-check', '{"title":"Utkast"}'::jsonb)`,
];

/**
 * A leader and a member of one team of the first department, and an admin place, written through the repositories
 * as the commands write them. The team is `TEAM_ID`, and its memberships run to 2099.
 */
const seedTeams = Effect.gen(function* seedTeams() {
  const field = yield* (yield* FieldOfStudyRepository).findById(
    FieldOfStudyId.make(1)
  );

  const people = yield* PersonRepository;
  const memberships = yield* MembershipRepository;
  const transactor = yield* Transactor;

  const person = (name: string, email: string) =>
    transactor.run(
      people.create({
        email: EmailAddress.make(email),
        fieldOfStudyId: field.id,
        name,
      })
    );

  const lise = yield* person(LOCAL_PERSON, "lise@alfa.example");
  const mats = yield* person("Mats Medlem", "mats@alfa.example");

  const team = yield* transactor.run(
    (yield* TeamRepository).create({
      defaultTerm: 2,
      departmentId: field.departmentId,
      function: "recruitment",
      groupEmail: null,
      name: "Rekruttering",
    })
  );

  assert.strictEqual(team.id, TEAM_ID, "the registered read paths ask for it");

  const term = {
    end: { term: "HOST", year: 2099 },
    start: { term: "VAR", year: 2020 },
  } as const;

  yield* transactor.run(
    Effect.gen(function* writeTeams() {
      const adminList = yield* lockAdminList;
      const locks = yield* AggregateLocks;
      const liseLock = yield* locks.lock("Person", lise.id);
      const matsLock = yield* locks.lock("Person", mats.id);

      yield* memberships.insert(liseLock, {
        ...term,
        leader: true,
        positionId: PositionId.make(1),
        teamId: team.id,
      });
      yield* memberships.insert(matsLock, {
        ...term,
        leader: false,
        positionId: PositionId.make(2),
        teamId: team.id,
      });

      yield* (yield* AdminGrantRepository).create(adminList, liseLock, {
        grantedBy: null,
        until: DateTime.makeUnsafe("2099-12-31T00:00:00Z"),
      });
    })
  );
});

/** The job's two rows, the teams, and an event in the current semester of the first department. */
const seedDatabase = Effect.gen(function* seedDatabase() {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(SEED, (statement) => sql.unsafe(statement), {
    discard: true,
  });
  yield* seedTeams;

  const { current } = yield* Transactor.use((transactor) =>
    transactor.run(semesterJob)
  ).pipe(Effect.provideService(CurrentPrincipal, systemPrincipal("semesters")));

  yield* sql.unsafe(
    `insert into social_event (department_id, description, ends_at, semester_id, starts_at, title)
       values (1, '', now() + interval '2 hours', ${current.id}, now() + interval '1 hour', 'Sosialt')`
  );
  yield* sql.unsafe(
    `insert into admission_period (department_id, semester_id, starts_at, ends_at)
       values (1, ${current.id}, now() - interval '1 day', now() + interval '1 day')`
  );
}).pipe(
  Effect.provide(
    Layer.unwrap(
      Effect.map(Effect.service(TestDatabaseUrl), (url) => requestServices(url))
    )
  )
);

const readerContext = Effect.gen(function* readerContext() {
  const url = yield* ReadOnlyDatabaseUrl;

  return yield* Layer.build(requestServices(url));
});

const runAs = <A, E>(
  context: Context.Context<DatabaseServices | ContentEditor | FileStore | Auth>,
  principal: Principal,
  program: Effect.Effect<A, E, ReadServices>,
  cms: Partial<CmsSeed> = {}
) =>
  program.pipe(
    Effect.provideService(CurrentPrincipal, principal),
    Effect.provide(memoryCms(cms)),
    Effect.provideContext(context),
    Effect.exit
  );

/** The verdict on one run: it never dies, and it answers (or is `NotFound` or `Forbidden`) as the case says. */
const assertVerdict = (
  label: string,
  exit: Exit.Exit<unknown, unknown>,
  expected: Expected
) => {
  assert.isFalse(
    Exit.isFailure(exit) && Cause.hasDies(exit.cause),
    `${label} died: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
  );

  if (expected === "ok") {
    assert.isTrue(Exit.isSuccess(exit), `${label} answered`);

    return;
  }

  assert.isTrue(
    Exit.isFailure(exit) &&
      Option.exists(Exit.findErrorOption(exit), Predicate.isTagged(expected)),
    `${label} is ${expected}`
  );
};

/** What `path` answers `principalName` in `phase`: its own refusal, which comes before any row is read, or else its answer. */
const expectedFor = (
  path: ReadPath,
  phase: "empty" | "seeded",
  principalName: string
): Expected =>
  path.refusedTo.includes(principalName) ? "Forbidden" : path[phase];

const readEveryPath = (phase: "empty" | "seeded") =>
  Effect.gen(function* readEveryPathIn() {
    const context = yield* readerContext;

    for (const path of READ_PATHS) {
      for (const [principalName, principal] of ACTORS) {
        assertVerdict(
          `${path.site} as ${principalName} (${phase})`,
          yield* runAs(context, principal, path.program, CMS_SEEDS[phase]),
          expectedFor(path, phase, principalName)
        );
      }
    }
  });

/** What the retired loaders did: ask for the current semester's row, creating it when missing. */
const retiredEnsureCurrentSemester = Effect.gen(
  function* retiredEnsureCurrentSemester() {
    const semesters = yield* SemesterRepository;

    return yield* semesters.ensure(yield* currentSemester);
  }
);

layer(readOnlyRole.pipe(Layer.provideMerge(migratedTestDatabase)), {
  excludeTestServices: true,
})("spec 0003: reads never write (SELECT-only role)", (it) => {
  it.effect(
    "spec 0006 falsifier 9 and spec 0003 falsifier 3: every read path succeeds on empty tables",
    () => readEveryPath("empty")
  );

  it.effect(
    "spec 0006 falsifier 9 and spec 0003 falsifier 3: every read path succeeds on seeded tables",
    () =>
      Effect.gen(function* seededEffect() {
        yield* seedDatabase;
        const reader = yield* readerContext;

        const content = yield* panelReads.getContent.pipe(
          Effect.provideService(CurrentPrincipal, ADMIN),
          Effect.provideContext(reader)
        );

        assert.deepStrictEqual(
          Arr.map(content, (entry) => ({
            collection: entry.collection,
            draft: entry.draft,
            published: entry.published,
            slug: entry.slug,
          })),
          [
            {
              collection: "texts",
              draft: { title: "Utkast" },
              published: null,
              slug: "read-check",
            },
          ]
        );
        yield* readEveryPath("seeded");
      })
  );

  it.effect(
    "negative control: a read that writes (the retired ensureCurrentSemester) dies in the same harness, and the same program succeeds as the owner",
    () =>
      Effect.gen(function* negativeControlEffect() {
        const reader = yield* readerContext;
        const url = yield* TestDatabaseUrl;
        const owner = yield* Layer.build(requestServices(url));

        const denied = yield* runAs(
          reader,
          anonymous,
          retiredEnsureCurrentSemester
        );

        assert.isTrue(Exit.isFailure(denied) && Cause.hasDies(denied.cause));
        assert.include(
          Exit.isFailure(denied) ? Cause.pretty(denied.cause) : "",
          "permission denied"
        );
        assert.throws(() => {
          assertVerdict("the retired loader", denied, "ok");
        });

        const allowed = yield* runAs(
          owner,
          anonymous,
          retiredEnsureCurrentSemester
        );

        assert.isTrue(Exit.isSuccess(allowed));
      })
  );
});
