/**
 * Spec 0003, falsifier 3: every public and control-panel read path succeeds against a database role that
 * holds SELECT and nothing else, so no read writes.
 *
 * Each read program a server function (or the Worker entry) runs through `runQuery` is run, once per actor
 * (anonymous, admin, team leader), over `DatabaseLive` connected as the SELECT-only role of a migrated
 * disposable PostgreSQL database (`@vektorprogrammet/db/testing`). It runs twice: on empty tables (no
 * semester row yet: the state in which the retired `ensureCurrentSemester` inserted from three loaders) and
 * on seeded tables. A write is refused with `permission denied`, which `DatabaseLive` turns into a defect, so
 * any defect fails the test. The role itself is proven to read and to refuse every kind of write in
 * `packages/db/test/readOnlyRole.postgres.test.ts`; the negative controls here run a write through the same
 * harness.
 *
 * The list of read paths is written down here, so a new `runQuery` call site must be registered too:
 * the last test counts the call sites in the source.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import {
  ReadOnlyDatabaseUrl,
  readOnlyRole,
} from "@vektorprogrammet/db/testing/read-only-role";
import {
  CurrentActor,
  FileStore,
  SemesterRepository,
  anonymous,
  currentSemester,
  ensureScheduledSemesters,
  servePublicFile,
} from "@vektorprogrammet/domain";
import type { Actor, Forbidden, NotFound } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Stream,
} from "effect";
import type { Context, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { TEST_ACTORS } from "../src/server/actor";
import {
  articlePage,
  contactPage,
  footerSponsors,
  homePage,
  newsPage,
  staticBlocks,
} from "../src/server/pages";
import {
  articlesView,
  dashboardView,
  departmentsView,
  fieldsOfStudyView,
  semestersView,
  socialEventsView,
  sponsorsView,
  staticContentView,
} from "../src/server/panel";
import { legacyFileLocation } from "../src/server/redirects";
import type { DatabaseServices } from "../src/server/runtime";

type ReadServices = DatabaseServices | CurrentActor | FileStore;

/** Every source file of the app, as text: the read paths are checked against its `runQuery` call sites. */
const SOURCES = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** What a read path answers: a value, or the typed `NotFound` that a missing row means. */
type Expected = "ok" | "NotFound";

interface ReadPath {
  /** The server function (or entry point) that runs it. */
  readonly site: string;
  readonly program: Effect.Effect<unknown, Forbidden | NotFound, ReadServices>;
  readonly empty: Expected;
  readonly seeded: Expected;
}

const readPath = (
  site: string,
  program: ReadPath["program"],
  expected: Partial<Pick<ReadPath, "empty" | "seeded">> = {}
): ReadPath => ({ empty: "ok", seeded: "ok", ...expected, program, site });

const KEY_SMALL = `${"a".repeat(64)}.png`;
const KEY_LARGE = `${"b".repeat(64)}.png`;
const LEGACY_PATH = "Offentlige filer/logo.png";

/** Every `runQuery` call site of the app, by the server function or entry point that holds it. */
const READ_PATHS: readonly ReadPath[] = [
  readPath("public.functions getHomePage", homePage),
  readPath("public.functions getStaticPage omvektor", staticBlocks("omvektor")),
  readPath("public.functions getStaticPage foreldre", staticBlocks("foreldre")),
  readPath(
    "public.functions getNewsPage",
    newsPage({ department: null, page: 1 })
  ),
  readPath(
    "public.functions getNewsPage (department)",
    newsPage({ department: "alfa", page: 1 }),
    { empty: "NotFound" }
  ),
  readPath("public.functions getArticlePage", articlePage("opptak-apner"), {
    empty: "NotFound",
  }),
  readPath("public.functions getArticlePage (draft)", articlePage("utkast"), {
    empty: "NotFound",
    seeded: "NotFound",
  }),
  readPath("public.functions getFooter", footerSponsors),
  readPath("public.functions getContactPage", contactPage(null)),
  readPath("public.functions getContactPage (receipt)", contactPage(1)),
  readPath("panel.functions getDashboard", dashboardView),
  readPath("panel.functions getDepartments", departmentsView),
  readPath("panel.functions getSemesters", semestersView),
  readPath("panel.functions getFieldsOfStudy", fieldsOfStudyView),
  readPath("panel.functions getStaticContentAdmin", staticContentView),
  readPath("panel.functions getArticlesAdmin", articlesView),
  readPath("panel.functions getSponsorsAdmin", sponsorsView),
  readPath("panel.functions getSocialEvents", socialEventsView),
  readPath("routes/filer/$key GET", servePublicFile(KEY_SMALL), {
    empty: "NotFound",
  }),
  readPath("server.ts legacy file redirect", legacyFileLocation(LEGACY_PATH)),
];

/** The `runQuery(` call sites in `src/`, by file: a new one means a new read path to register above. */
const RUN_QUERY_CALL_SITES = {
  "functions/panel.functions.ts": 8,
  "functions/public.functions.ts": 6,
  "routes/filer/$key.ts": 1,
  "server.ts": 1,
};

const ACTORS: readonly (readonly [string, Actor])[] = [
  ["anonymous", anonymous],
  ["admin", TEST_ACTORS.admin],
  ["team leader", TEST_ACTORS.teamLeader],
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
  fileStore.pipe(
    Layer.provideMerge(DatabaseLive({ maxConnections: 2, url })),
    Layer.orDie
  );

/** The fixture: a department with a field of study, a published article and a draft, a sponsor, a file. */
const SEED = [
  `insert into public_file (key, sha256, content_type, name, size, uploaded_at, legacy_path) values
     ('${KEY_SMALL}', '${"a".repeat(64)}', 'image/png', 'liten.png', 1, now(), '${LEGACY_PATH}'),
     ('${KEY_LARGE}', '${"b".repeat(64)}', 'image/png', 'stor.png', 1, now(), null)`,
  `insert into department (id, city, email, name, short_name, active, logo_key) values
     (1, 'Alfaby', 'kontakt@alfa.example', 'Avdeling Alfa', 'ALFA', true, '${KEY_SMALL}'),
     (2, 'Betaby', 'kontakt@beta.example', 'Avdeling Beta', 'BETA', false, null)`,
  `insert into field_of_study (department_id, name, short_name) values (1, 'Fag Alfa', 'FA')`,
  `insert into article (id, author_id, body, created_at, image_large_key, image_small_key, published, slug, sticky, title) values
     (1, 42, '<p>Søk nå</p>', now(), '${KEY_LARGE}', '${KEY_SMALL}', true, 'opptak-apner', true, 'Opptak åpner'),
     (2, 42, '<p>Kommer</p>', now(), '${KEY_LARGE}', '${KEY_SMALL}', false, 'utkast', false, 'Utkast')`,
  `insert into article_department (article_id, department_id) values (1, 1)`,
  `insert into static_content (key, html) values ('about-header', '<p>Om oss</p>'), ('home-tagline', '<p>Hei</p>')`,
  `insert into sponsor (name, size, url, logo_key) values ('Sponsor', 'medium', 'https://example.org', '${KEY_SMALL}')`,
];

/** The job's two rows, and an event in the current semester of the first department. */
const seedDatabase = Effect.gen(function* seedDatabase() {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(SEED, (statement) => sql.unsafe(statement), {
    discard: true,
  });

  const { current } = yield* ensureScheduledSemesters;

  yield* sql.unsafe(
    `insert into social_event (department_id, description, ends_at, semester_id, starts_at, title)
       values (1, '', now() + interval '2 hours', ${current.id}, now() + interval '1 hour', 'Sosialt')`
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
  context: Context.Context<DatabaseServices | FileStore>,
  actor: Actor,
  program: Effect.Effect<A, E, ReadServices>
) =>
  program.pipe(
    Effect.provideService(CurrentActor, actor),
    Effect.provideContext(context),
    Effect.exit
  );

/** The verdict on one run: it never dies, and it answers (or is `NotFound`) as the case says. */
const assertVerdict = (
  label: string,
  exit: Exit.Exit<unknown, unknown>,
  expected: Expected
) => {
  assert.isFalse(
    Exit.hasDies(exit),
    `${label} died: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
  );

  if (expected === "ok") {
    assert.isTrue(Exit.isSuccess(exit), `${label} answered`);

    return;
  }

  assert.isTrue(
    Exit.isFailure(exit) &&
      Option.exists(Exit.findErrorOption(exit), Predicate.isTagged("NotFound")),
    `${label} is NotFound`
  );
};

const readEveryPath = (phase: "empty" | "seeded") =>
  Effect.gen(function* readEveryPathIn() {
    const context = yield* readerContext;

    for (const path of READ_PATHS) {
      for (const [actorName, actor] of ACTORS) {
        assertVerdict(
          `${path.site} as ${actorName} (${phase})`,
          yield* runAs(context, actor, path.program),
          path[phase]
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
    "falsifier 3: every public and control-panel read path succeeds on empty tables, with no semester row yet",
    () => readEveryPath("empty")
  );

  it.effect(
    "falsifier 3: every read path succeeds on seeded tables, with the job's semesters and an event in the current one",
    () =>
      Effect.gen(function* seededEffect() {
        yield* seedDatabase;
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

        assert.isTrue(Exit.hasDies(denied));
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

  it("the registered read paths cover every runQuery call site in the source", () => {
    const counted = Arr.map(
      Rec.toEntries(SOURCES),
      ([file, text]) =>
        [
          file.replace("../src/", ""),
          Arr.length(text.match(/\brunQuery\(/gu) ?? []),
        ] as const
    );

    // `server/runtime.ts` defines `runQuery`; every other file that calls it is a read path.
    const sites = Rec.fromEntries(
      Arr.filter(
        counted,
        ([file, count]) => count > 0 && file !== "server/runtime.ts"
      )
    );

    assert.deepStrictEqual(sites, RUN_QUERY_CALL_SITES);
  });

  it("falsifier 4: no semester create command or server function exists, and the Worker's job is the only caller of the semester job", () => {
    const files = Arr.map(
      Rec.toEntries(SOURCES),
      ([file, text]) => [file.replace("../src/", ""), text] as const
    );

    const naming = (pattern: RegExp) =>
      Arr.map(
        Arr.filter(files, ([, text]) => pattern.test(text)),
        ([file]) => file
      );

    assert.deepStrictEqual(
      naming(
        /createSemester|saveSemester|semesterInput|ensureCurrentSemester/u
      ),
      []
    );
    assert.deepStrictEqual(naming(/ensureScheduledSemesters/u), [
      "server/runtime.ts",
    ]);
    assert.deepStrictEqual(Arr.sort(naming(/runSemesterJob/u), Order.String), [
      "server.ts",
      "server/runtime.ts",
    ]);
  });
});
