/** Writing a plan to the CMS: create then publish, a rerun that changes nothing, refusals, and an unreachable CMS. */
import { assert, describe, it } from "@effect/vitest";
import { CmsRejected, CmsUnavailable } from "@vektorprogrammet/cms-client";
import { DateTime, Effect, Option } from "effect";

import { planEmDashContent } from "../../src/emdash/plan.ts";
import { writeContent } from "../../src/emdash/write.ts";
import type { LegacySnapshot } from "../../src/legacy/rows.ts";
import { makeFakeCms } from "../support/fakeCms.ts";

const SNAPSHOT: LegacySnapshot = {
  admissionPeriods: [],
  articleDepartments: [{ articleId: 1, departmentId: 1 }],
  articles: [
    {
      authorId: null,
      body: "<p>Åpent</p>",
      created: "2024-01-15 12:00:00",
      id: 1,
      imageLarge: "",
      imageSmall: "",
      published: 1,
      slug: "opptak-apner",
      sticky: 1,
      title: "Tittel 1",
    },
    {
      authorId: null,
      body: "<p>Utkast</p>",
      created: "2024-02-01 09:30:00",
      id: 2,
      imageLarge: "",
      imageSmall: "",
      published: 0,
      slug: "kladd",
      sticky: 0,
      title: "Tittel 2",
    },
  ],
  departments: [
    {
      active: 1,
      address: null,
      city: "Trondheim",
      email: "kontakt@example.org",
      id: 1,
      latitude: null,
      logoPath: null,
      longitude: null,
      name: "Avdeling",
      shortName: "A",
      slackChannel: null,
    },
  ],
  fieldsOfStudy: [],
  semesters: [],
  socialEvents: [],
  sponsors: [
    {
      id: 1,
      logoImagePath: null,
      name: "Sponsor",
      size: "large",
      url: "https://sponsor.example",
    },
  ],
  staticContents: [{ html: "<p>Hei</p>", htmlId: "home-tagline", id: 1 }],
};

const PLAN = planEmDashContent(
  SNAPSHOT,
  DateTime.makeUnsafe("2024-10-16T12:00:00.000Z")
);

describe("writeContent", () => {
  it.effect(
    "creates every planned entry and publishes the ones that were live",
    () => {
      const cms = makeFakeCms();

      return Effect.gen(function* createsAndPublishes() {
        const written = yield* writeContent(PLAN);
        const results = written.collections;

        assert.deepStrictEqual(results.news, {
          collection: "news",
          drafted: 1,
          inCms: { draft: 1, published: 1 },
          published: 1,
          rejections: [],
          unchanged: 0,
        });
        assert.deepStrictEqual(results.texts.inCms, { draft: 0, published: 1 });
        assert.deepStrictEqual(results.sponsors.inCms, {
          draft: 0,
          published: 1,
        });
        assert.strictEqual(written.departmentOptionsAdded, 1);
        assert.deepStrictEqual(cms.options.get("news.departments"), [
          "Trondheim",
        ]);
        assert.strictEqual(
          cms.news.stored.get("opptak-apner")?.status,
          "published"
        );
        assert.strictEqual(cms.news.stored.get("kladd")?.status, "draft");
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "a rerun creates nothing, and leaves an entry an editor unpublished alone",
    () => {
      const cms = makeFakeCms();

      return Effect.gen(function* rerunsSafely() {
        yield* writeContent(PLAN);

        const unpublished = cms.news.stored.get("opptak-apner");

        if (unpublished !== undefined) {
          unpublished.status = "draft";
        }

        const second = (yield* writeContent(PLAN)).collections;

        assert.deepStrictEqual(
          [second.news.drafted, second.news.published, second.news.unchanged],
          [0, 0, 2]
        );
        assert.deepStrictEqual(
          [second.texts.unchanged, second.sponsors.unchanged],
          [1, 1]
        );
        assert.deepStrictEqual(second.news.inCms, { draft: 2, published: 0 });
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "counts an entry the CMS refuses with its error code, and goes on with the rest",
    () => {
      const cms = makeFakeCms((data) =>
        data.title === "Tittel 2"
          ? Option.some(
              new CmsRejected({
                code: "VALIDATION_ERROR",
                message: "refused",
                operation: "createContent",
                status: 400,
              })
            )
          : Option.none()
      );

      return Effect.gen(function* countsRefusals() {
        const { news } = (yield* writeContent(PLAN)).collections;

        assert.deepStrictEqual(news.rejections, [
          {
            code: "VALIDATION_ERROR",
            collection: "news",
            id: "2",
            operation: "create",
          },
        ]);
        assert.deepStrictEqual([news.drafted, news.published], [0, 1]);
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect("stops when the CMS cannot be reached", () => {
    const cms = makeFakeCms(() =>
      Option.some(
        new CmsUnavailable({ operation: "createContent", reason: "no answer" })
      )
    );

    return Effect.gen(function* stopsWhenUnavailable() {
      const reason = yield* writeContent(PLAN).pipe(
        Effect.catchTag("CmsUnavailable", (unavailable) =>
          Effect.succeed(unavailable.reason)
        )
      );

      assert.strictEqual(reason, "no answer");
    }).pipe(Effect.provide(cms.layer));
  });
});
