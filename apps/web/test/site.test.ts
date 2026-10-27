/**
 * The public pages' programs over the in-memory CMS (`support/cms.ts`) and the in-memory organisation data. The
 * rules are the legacy ones (RULE-119 admission, RULE-267 drafts are 404, RULE-326 pagination, RULE-331 front page
 * news); what changed with spec 0005 is where the content comes from.
 */
import { assert, describe, it } from "@effect/vitest";
import { isNotFound } from "@tanstack/react-router";
import { CmsClient, PortableText } from "@vektorprogrammet/cms-client";
import type { NewsData } from "@vektorprogrammet/cms-client";
import { DepartmentId } from "@vektorprogrammet/domain";
import type { AdmissionPeriod } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Layer,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { pageData } from "../src/lib/outcome";
import type { Outcome } from "../src/lib/outcome";
import { TEXT_SLOTS } from "../src/lib/textSlots";
import { runOutcome } from "../src/server/runtime";
import {
  aboutPage,
  articlePage,
  contactPage,
  departmentSlug,
  departmentSlugById,
  footerSponsors,
  homePage,
  newsPage,
  teamPage,
} from "../src/server/site/pages";
import { draft, memoryCms, paragraph, published, textsOf } from "./support/cms";
import type { CmsSeed } from "./support/cms";
import { fakeDepartment, makeTables, memoryLayer } from "./support/memory";
import type { MemoryTables } from "./support/memory";

const { signal } = new AbortController();

/** 2026-02-15 12:00 UTC; the seeds' days count from 2026-01-01. */
const NOW = Date.UTC(2026, 1, 15, 12);

const DEPARTMENTS = [
  fakeDepartment(1, "Trondheim"),
  fakeDepartment(2, "Bergen"),
  fakeDepartment(3, "Ås"),
];

const day = (n: number) =>
  DateTime.add(DateTime.makeUnsafe(Date.UTC(2026, 0, 1)), { days: n });

const period = (
  departmentId: number,
  startDay: number,
  endDay: number
): AdmissionPeriod => ({
  departmentId: DepartmentId.make(departmentId),
  end: day(endDay),
  semester: { term: "VAR", year: 2026 },
  start: day(startDay),
});

const layerOf = (options: {
  readonly cms?: Partial<CmsSeed>;
  readonly tables?: Partial<MemoryTables>;
}) =>
  Layer.mergeAll(
    memoryLayer(makeTables({ departments: DEPARTMENTS, ...options.tables })),
    memoryCms(options.cms)
  );

/** The article `n`, published on day `n`. */
const news = (n: number, data: Partial<NewsData> = {}) =>
  published(
    `nyhet-${n}`,
    { content: paragraph(`Tekst ${n}`), title: `Nyhet ${n}`, ...data },
    n
  );

/** One news item in six (1, 7, 13, …) is for Bergen only; the rest are for every department. */
const tagged = (n: number) =>
  news(n, { departments: n % 6 === 1 ? ["Bergen"] : [] });

const contact = (slug: string | null, sent: boolean) =>
  contactPage(slug, sent).pipe(Effect.provide(layerOf({})));

/** A route loader's view of a page outcome: its data, or the `notFound()` it throws. */
const load = <A>(outcome: Promise<Outcome<A>>) =>
  Effect.promise(async () => await outcome).pipe(
    Effect.map((result) => {
      try {
        return { data: pageData(result) };
      } catch (error) {
        return { error };
      }
    })
  );

const articleOutcome = (slug: string, cms: Partial<CmsSeed>) =>
  load(runOutcome(layerOf({ cms }), articlePage(slug), signal));

describe("C5 article page (/nyhet/{slug})", () => {
  const cms = { news: [draft("utkast", { title: "Utkast" }, 1), news(2)] };

  it.effect(
    "RULE-267: a draft's public URL is 404 at the loader (notFound)",
    () =>
      Effect.gen(function* draftArticle404() {
        const result = yield* articleOutcome("utkast", cms);

        assert.isTrue("error" in result && isNotFound(result.error));
      })
  );

  it.effect("RULE-267: an unknown slug is 404 too", () =>
    Effect.gen(function* unknownArticle404() {
      const result = yield* articleOutcome("finnes-ikke", cms);

      assert.isTrue("error" in result && isNotFound(result.error));
    })
  );

  it.effect(
    "RULE-267: a published article renders its text, its Oslo date and the image on the CMS",
    () =>
      Effect.gen(function* publishedArticle() {
        const article = yield* articlePage("nyhet-2").pipe(
          Effect.provide(
            layerOf({
              cms: {
                news: [
                  news(2, {
                    image: {
                      alt: "Bilde",
                      id: "img",
                      src: "/_emdash/api/media/file/abc",
                    },
                  }),
                  news(3),
                  draft("utkast", { title: "Utkast" }, 4),
                ],
              },
            })
          )
        );

        assert.strictEqual(article.title, "Nyhet 2");
        assert.strictEqual(article.date, "03.01.2026");
        assert.deepStrictEqual(article.content, paragraph("Tekst 2"));
        assert.deepStrictEqual(article.image, {
          alt: "Bilde",
          src: "https://cms.test/_emdash/api/media/file/abc",
        });
        assert.deepStrictEqual(
          Arr.map(article.others, (other) => other.slug),
          ["nyhet-3"]
        );
      })
  );

  it.effect("RULE-267: drafts never appear in the news list", () =>
    Effect.gen(function* draftExcludedFromNews() {
      const view = yield* newsPage({ department: null, page: 1 }).pipe(
        Effect.provide(layerOf({ cms }))
      );

      assert.deepStrictEqual(
        Arr.map(view.items, (item) => item.slug),
        ["nyhet-2"]
      );
    })
  );

  it.effect(
    "an entry an editor publishes shows on the next read, with no deploy",
    () =>
      Effect.gen(function* publishWithoutDeploy() {
        const layer = layerOf({});

        const before = yield* articlePage("ny-sak").pipe(
          Effect.flip,
          Effect.provide(layer)
        );

        assert.isTrue(Predicate.isTagged(before, "NotFound"));

        yield* Effect.gen(function* editorPublishes() {
          const { news: collection } = yield* CmsClient;

          const created = yield* collection.create({
            createdAt: day(5),
            data: { content: paragraph("Fersk"), title: "Ny sak" },
            publishedAt: day(5),
            slug: "ny-sak",
          });

          assert.isTrue(Predicate.isTagged(created, "Created"));

          if (Predicate.isTagged(created, "Created")) {
            const stillDraft = yield* articlePage("ny-sak").pipe(Effect.flip);
            assert.isTrue(Predicate.isTagged(stillDraft, "NotFound"));
            yield* collection.publish(created.id);
          }
        }).pipe(Effect.provide(layer));

        const after = yield* articlePage("ny-sak").pipe(Effect.provide(layer));
        assert.strictEqual(after.title, "Ny sak");
      })
  );
});

describe("C5 news list (/nyheter)", () => {
  const cms: Partial<CmsSeed> = {
    news: [
      ...Arr.map(Arr.range(1, 35), tagged),
      draft("utkast", { title: "Utkast" }, 50),
    ],
  };

  const page = (number: number, department: string | null = null) =>
    newsPage({ department, page: number }).pipe(
      Effect.provide(layerOf({ cms }))
    );

  it.effect(
    "RULE-326: 35 published articles give 4 pages of 10, 10, 10 and 5",
    () =>
      Effect.gen(function* newsPagination() {
        const views = yield* Effect.all([page(1), page(2), page(3), page(4)]);

        assert.deepStrictEqual(
          Arr.map(views, (view) => view.items.length),
          [10, 10, 10, 5]
        );
        assert.deepStrictEqual(
          Arr.map(views, (view) => view.totalPages),
          [4, 4, 4, 4]
        );
        assert.strictEqual(views[0]?.totalItems, 35);
      })
  );

  it.effect("RULE-326: newest first across pages", () =>
    Effect.gen(function* newestArticleFirst() {
      const [first, last] = yield* Effect.all([page(1), page(4)]);

      assert.strictEqual(first?.items[0]?.slug, "nyhet-35");
      assert.strictEqual(last?.items.at(-1)?.slug, "nyhet-1");
    })
  );

  it.effect("RULE-326: a page past the end is empty, not an error", () =>
    Effect.gen(function* pagePastEnd() {
      const view = yield* page(5);

      assert.deepStrictEqual(view.items, []);
      assert.strictEqual(view.page, 5);
    })
  );

  it.effect(
    "a department sees the articles tagged with its city and the untagged ones, by slug or short name",
    () =>
      Effect.gen(function* departmentNews() {
        const [byShortName, bySlug, other] = yield* Effect.all([
          page(1, "TRON"),
          page(1, "trondheim"),
          page(1, "bergen"),
        ]);

        // Articles 1, 7, 13, 19, 25, 31 are tagged Bergen only, so Trondheim sees 35 - 6 = 29.
        assert.strictEqual(byShortName.totalItems, 29);
        assert.strictEqual(bySlug.totalItems, 29);
        assert.strictEqual(other.totalItems, 35);
        assert.strictEqual(byShortName.department?.city, "Trondheim");
        assert.isFalse(byShortName.unknownDepartment);
      })
  );

  it.effect("an unknown department shows every article and says so", () =>
    Effect.gen(function* unknownDepartment() {
      const view = yield* page(1, "ukjent");

      assert.isTrue(view.unknownDepartment);
      assert.strictEqual(view.department, null);
      assert.strictEqual(view.totalItems, 35);
    })
  );
});

describe("C3 home page (/)", () => {
  const cms: Partial<CmsSeed> = {
    news: [
      news(-100, { sticky: true }),
      news(0),
      news(30),
      news(40),
      news(41),
      news(44),
      draft("utkast", { title: "Utkast" }, 44),
    ],
    texts: textsOf({ "home-tagline": paragraph("Matematikk er gøy") }),
  };

  const tables: Partial<MemoryTables> = {
    admissionPeriods: [period(1, 31, 59), period(2, 0, 31)],
  };

  const home = Effect.gen(function* homeAt() {
    yield* TestClock.setTime(NOW);

    return yield* homePage;
  }).pipe(Effect.provide(layerOf({ cms, tables })));

  it.effect(
    "RULE-331: sticky news first, then newest first, from the last 30 days, at most three",
    () =>
      Effect.gen(function* frontPageNews() {
        const view = yield* home;

        // 30 days before 2026-02-15 is 2026-01-16: nyhet-0 (1 January) is too old, the sticky one is not.
        assert.deepStrictEqual(
          Arr.map(view.news, (card) => card.slug),
          ["nyhet--100", "nyhet-44", "nyhet-41"]
        );
      })
  );

  it.effect(
    "RULE-119: a department's admission is open iff a period of it contains now",
    () =>
      Effect.gen(function* admissionOpen() {
        const view = yield* home;

        assert.deepStrictEqual(
          Arr.map(view.departments, (department) => [
            department.slug,
            department.admissionOpen,
          ]),
          [
            ["bergen", false],
            ["trondheim", true],
            ["aas", false],
          ]
        );
      })
  );

  it.effect("the tagline is the published text of its slot", () =>
    Effect.gen(function* tagline() {
      const view = yield* home;

      assert.deepStrictEqual(
        view.texts["home-tagline"],
        paragraph("Matematikk er gøy")
      );
    })
  );
});

describe("the text slots of a page", () => {
  it.effect(
    "a page has exactly its slots; a slot with no published text is null, a draft is not shown",
    () =>
      Effect.gen(function* textSlots() {
        const view = yield* aboutPage.pipe(
          Effect.provide(
            layerOf({
              cms: {
                texts: [
                  ...textsOf({ "about-header": paragraph("Om oss") }),
                  draft("about-faq", {
                    content: paragraph("Skjult"),
                    title: "about-faq",
                  }),
                ],
              },
            })
          )
        );

        assert.deepStrictEqual(Rec.keys(view.texts), [...TEXT_SLOTS.about]);
        assert.deepStrictEqual(view.texts["about-header"], paragraph("Om oss"));
        assert.strictEqual(view.texts["about-faq"], null);
      })
  );
});

describe("the footer sponsors", () => {
  it.effect("large first, then medium, then small, by name within a size", () =>
    Effect.gen(function* footer() {
      const sponsors = yield* footerSponsors.pipe(
        Effect.provide(
          layerOf({
            cms: {
              sponsors: [
                published("b", {
                  name: "B",
                  size: "small",
                  url: "https://b.example",
                }),
                published("z", {
                  name: "Z",
                  size: "large",
                  url: "https://z.example",
                }),
                published("a", {
                  name: "A",
                  size: "large",
                  url: "https://a.example",
                }),
                published("m", {
                  name: "M",
                  size: "medium",
                  url: "https://m.example",
                }),
                draft("d", {
                  name: "D",
                  size: "large",
                  url: "https://d.example",
                }),
              ],
            },
          })
        )
      );

      assert.deepStrictEqual(
        Arr.map(sponsors, (sponsor) => sponsor.name),
        ["A", "Z", "M", "B"]
      );
    })
  );
});

describe("the team page (/team)", () => {
  const cms: Partial<CmsSeed> = {
    faq: [
      published("t2", {
        answer: "Svar 2",
        page: "team",
        position: 2,
        question: "Spørsmål 2",
      }),
      published("t1", {
        answer: "Svar 1",
        page: "team",
        position: 1,
        question: "Spørsmål 1",
      }),
      published("a1", {
        answer: "Svar A",
        page: "assistenter",
        position: 1,
        question: "Spørsmål A",
      }),
    ],
    teams: [
      published("it", { department: "Bergen", name: "IT", position: 2 }),
      published("web", {
        department: "bergen",
        description: "Nettsiden",
        email: "web@example.org",
        name: "Web",
        position: 1,
      }),
      published("tr", {
        department: "Trondheim",
        name: "Trondheim-teamet",
        position: 1,
      }),
    ],
  };

  const team = (slug: string | null) =>
    teamPage(slug).pipe(Effect.provide(layerOf({ cms })));

  it.effect(
    "shows the teams of a department by position, matching its city in any case",
    () =>
      Effect.gen(function* teamsOfDepartment() {
        const view = yield* team("bergen");

        assert.strictEqual(view.selected?.city, "Bergen");
        assert.deepStrictEqual(view.teams, [
          { description: "Nettsiden", email: "web@example.org", name: "Web" },
          { description: null, email: null, name: "IT" },
        ]);
      })
  );

  it.effect(
    "selects the first department (by name) when none is named, and lists the team questions only",
    () =>
      Effect.gen(function* firstDepartment() {
        const view = yield* team(null);

        assert.strictEqual(view.selected?.city, "Bergen");
        assert.deepStrictEqual(view.faq, [
          { answer: "Svar 1", question: "Spørsmål 1" },
          { answer: "Svar 2", question: "Spørsmål 2" },
        ]);
      })
  );

  it.effect("an unknown department is NotFound", () =>
    Effect.gen(function* unknownDepartment() {
      const failure = yield* team("ukjent").pipe(Effect.flip);

      assert.isTrue(Predicate.isTagged(failure, "NotFound"));
    })
  );
});

describe("the contact page (/kontakt)", () => {
  it.effect(
    "RULE-156: the receipt notice names the department's address, and only after a post",
    () =>
      Effect.gen(function* receipt() {
        const [sent, idle] = yield* Effect.all([
          contact("bergen", true),
          contact("bergen", false),
        ]);

        assert.strictEqual(
          sent.notice,
          "Kontaktforespørsel sendt til bergen@example.org, takk for henvendelsen!"
        );
        assert.strictEqual(idle.notice, null);
      })
  );

  it.effect(
    "spec 0007b falsifier 1: the page carries a notice that lists the form's personal fields, and only those",
    () =>
      Effect.gen(function* notice() {
        const { privacy } = yield* contact(null, false);

        // `departmentId` is the organisation's, not the visitor's: the notice leaves it out.
        assert.deepStrictEqual(
          Arr.map(privacy.entries, (entry) => entry.field),
          ["email", "message", "name", "subject"]
        );
        assert.strictEqual(privacy.form, "contact");
        // The periods and the text await the operator: the page says it is a draft until they are decided.
        assert.strictEqual(privacy.approval, "proposed");
        assert.match(privacy.controller.no, /Vektorprogrammet/u);
      })
  );

  it.effect(
    "selects the first department when the URL names none; an unknown department is NotFound",
    () =>
      Effect.gen(function* selection() {
        const first = yield* contact(null, false);
        const failure = yield* contact("ukjent", false).pipe(Effect.flip);

        assert.strictEqual(first.selected.city, "Bergen");
        assert.isTrue(Predicate.isTagged(failure, "NotFound"));
      })
  );

  it.effect(
    "a legacy department id answers its slug; an unknown id is NotFound",
    () =>
      Effect.gen(function* legacyId() {
        const known = yield* departmentSlugById(3).pipe(
          Effect.provide(layerOf({}))
        );

        const failure = yield* departmentSlugById(99).pipe(
          Effect.flip,
          Effect.provide(layerOf({}))
        );

        assert.strictEqual(known, "aas");
        assert.isTrue(Predicate.isTagged(failure, "NotFound"));
      })
  );
});

describe("a department's URL segment", () => {
  it("is its city as a slug, with Å written as aa", () => {
    assert.strictEqual(departmentSlug("Trondheim"), "trondheim");
    assert.strictEqual(departmentSlug("Ås"), "aas");
    assert.strictEqual(departmentSlug("Ålesund"), "aalesund");
    assert.strictEqual(
      departmentSlug("Skien og Porsgrunn"),
      "skien-og-porsgrunn"
    );
  });
});

const picture = (url: string) =>
  ({ _type: "image", alt: "Elever", asset: { _ref: "m", url } }) as const;

const urlOf = (block: PortableText.PortableTextBlock) =>
  Schema.is(PortableText.ImageBlock)(block) ? block.asset.url : undefined;

describe("the pictures in a text", () => {
  it.effect(
    "an editor's pictures are shown from the CMS origin; an address that is already absolute is left alone",
    () =>
      Effect.gen(function* mediaOrigin() {
        const [about, article] = yield* Effect.all([
          aboutPage,
          articlePage("nyhet-1"),
        ]).pipe(
          Effect.provide(
            layerOf({
              cms: {
                news: [
                  news(1, { content: [picture("/_emdash/api/media/file/m1")] }),
                ],
                texts: textsOf({
                  "about-header": [
                    picture("/_emdash/api/media/file/m2"),
                    picture("https://elsewhere.example/x.png"),
                  ],
                }),
              },
            })
          )
        );

        assert.deepStrictEqual(
          Arr.map(about.texts["about-header"] ?? [], urlOf),
          [
            "https://cms.test/_emdash/api/media/file/m2",
            "https://elsewhere.example/x.png",
          ]
        );
        assert.deepStrictEqual(Arr.map(article.content, urlOf), [
          "https://cms.test/_emdash/api/media/file/m1",
        ]);
      })
  );
});
