import { createServerFn } from "@tanstack/react-start";
/**
 * Server functions for `/kontrollpanel`. Every write is a domain command run
 * through `runCommand` (one transaction: authorize, validate, write, audit).
 * Commands answer with a short notice; pages re-load their data afterwards.
 * Uploads are two steps: `storeUpload` outside the transaction, then
 * `registerPublicFile` inside it together with the command that uses the key.
 */
import {
  ArticleId,
  createArticle,
  createSocialEvent,
  createSponsor,
  decodeInput,
  registerPublicFile,
  setArticlePublished,
  updateStaticContent,
} from "@vektorprogrammet/domain";
import { Effect, Schema } from "effect";

import {
  SAVED,
  articleInput,
  articlesView,
  checkbox,
  dashboardView,
  departmentsView,
  fieldsOfStudyView,
  readFile,
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  saveSemesterProgram,
  semestersView,
  socialEventInput,
  socialEventsView,
  sponsorInput,
  sponsorsView,
  staticContentInput,
  staticContentView,
  storeOptional,
  text,
} from "../server/panel";
import { runCommand, runPreparedCommand, runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";

const formData = Schema.toStandardSchemaV1(Schema.FormData);

const decodeArticleId = decodeInput(ArticleId);

// ---------------------------------------------------------------- views

export const getDashboard = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), dashboardView)
);

export const getDepartments = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), departmentsView)
);

export const getSemesters = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), semestersView)
);

export const getFieldsOfStudy = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), fieldsOfStudyView)
);

export const getStaticContentAdmin = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), staticContentView)
);

export const getArticlesAdmin = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), articlesView)
);

export const getSponsorsAdmin = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), sponsorsView)
);

export const getSocialEvents = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), socialEventsView)
);

// ---------------------------------------------------------------- C1

export const saveDepartment = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveDepartmentProgram(data))
  );

export const saveSemester = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveSemesterProgram(data))
  );

export const saveFieldOfStudy = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveFieldOfStudyProgram(data))
  );

// ---------------------------------------------------------------- C4

export const saveStaticContent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(updateStaticContent(staticContentInput(data)), SAVED)
    )
  );

// ---------------------------------------------------------------- C5

export const saveArticle = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runPreparedCommand(
      requestScope(context),
      Effect.flatMap(
        Effect.all({
          large: readFile(data, "imageLarge"),
          small: readFile(data, "imageSmall"),
        }),
        ({ small, large }) =>
          Effect.all({
            large: storeOptional(large, "image"),
            small: storeOptional(small, "image"),
          })
      ),
      (stored) =>
        Effect.gen(function* saveArticleEffect() {
          if (stored.small !== null) {
            yield* registerPublicFile(stored.small);
          }

          if (stored.large !== null) {
            yield* registerPublicFile(stored.large);
          }

          const created = yield* createArticle(
            articleInput(data, {
              large: stored.large?.key,
              small: stored.small?.key,
            })
          );

          return created.notice;
        })
    )
  );

export const publishArticle = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.flatMap(decodeArticleId(Number(text(data, "id"))), (articleId) =>
        setArticlePublished(articleId, checkbox(data, "published"))
      ).pipe(Effect.as(SAVED))
    )
  );

// ---------------------------------------------------------------- C6

export const saveSponsor = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runPreparedCommand(
      requestScope(context),
      Effect.flatMap(readFile(data, "logo"), (logo) =>
        storeOptional(logo, "image")
      ),
      (stored) =>
        Effect.gen(function* saveSponsorEffect() {
          if (stored !== null) {
            yield* registerPublicFile(stored);
          }

          yield* createSponsor(sponsorInput(data, stored?.key ?? null));

          return SAVED;
        })
    )
  );

// ---------------------------------------------------------------- C8

export const saveSocialEvent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(createSocialEvent(socialEventInput(data)), SAVED)
    )
  );
