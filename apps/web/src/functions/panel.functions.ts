/**
 * Server functions for `/kontrollpanel`. Every write is a domain command run
 * through `runCommand` (one transaction: authorize, validate, write, audit).
 * Commands answer with a short notice; pages re-load their data afterwards.
 * Uploads are two steps: `storeUpload` outside the transaction, then
 * `registerPublicFile` inside it together with the command that uses the key.
 */
import {
  ArticleId,
  DepartmentId,
  FieldOfStudyId,
  createArticle,
  createDepartment,
  createFieldOfStudy,
  createSemester,
  createSocialEvent,
  createSponsor,
  decodeInput,
  registerPublicFile,
  renameFieldOfStudy,
  setArticlePublished,
  updateDepartment,
  updateStaticContent,
} from "@vektorprogrammet/domain";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import {
  articleInput,
  articlesView,
  checkbox,
  dashboardView,
  departmentInput,
  fieldOfStudyInput,
  fieldOfStudyRename,
  fieldsOfStudyView,
  readFile,
  semesterInput,
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

const SAVED = "Lagret.";

const formData = (data: unknown): FormData => {
  if (!(data instanceof FormData)) throw new Error("Forventet skjemadata.");
  return data;
};

const decodeDepartmentId = decodeInput(DepartmentId);
const decodeFieldOfStudyId = decodeInput(FieldOfStudyId);
const decodeArticleId = decodeInput(ArticleId);

// ---------------------------------------------------------------- views

export const getDashboard = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), dashboardView),
);

export const getSemesters = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), semestersView),
);

export const getFieldsOfStudy = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), fieldsOfStudyView),
);

export const getStaticContentAdmin = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), staticContentView),
);

export const getArticlesAdmin = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), articlesView),
);

export const getSponsorsAdmin = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), sponsorsView),
);

export const getSocialEvents = createServerFn({ method: "GET" }).handler(({ context }) =>
  runQuery(requestScope(context), socialEventsView),
);

// ---------------------------------------------------------------- C1

export const saveDepartment = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) => {
    const id = text(data, "id");
    const input = departmentInput(data);
    return runCommand(
      requestScope(context),
      (id === ""
        ? createDepartment(input)
        : Effect.flatMap(decodeDepartmentId(Number(id)), (departmentId) =>
            updateDepartment(departmentId, input),
          )
      ).pipe(Effect.as(SAVED)),
    );
  });

export const saveSemester = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), Effect.as(createSemester(semesterInput(data)), SAVED)),
  );

export const saveFieldOfStudy = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) => {
    const id = text(data, "id");
    return runCommand(
      requestScope(context),
      (id === ""
        ? createFieldOfStudy(fieldOfStudyInput(data))
        : Effect.flatMap(decodeFieldOfStudyId(Number(id)), (fieldOfStudyId) =>
            renameFieldOfStudy(fieldOfStudyId, fieldOfStudyRename(data)),
          )
      ).pipe(Effect.as(SAVED)),
    );
  });

// ---------------------------------------------------------------- C4

export const saveStaticContent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(updateStaticContent(staticContentInput(data)), SAVED),
    ),
  );

// ---------------------------------------------------------------- C5

export const saveArticle = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    Promise.all([readFile(data, "imageSmall"), readFile(data, "imageLarge")]).then(
      ([small, large]) =>
        runPreparedCommand(
          requestScope(context),
          Effect.all({
            small: storeOptional(small, "image"),
            large: storeOptional(large, "image"),
          }),
          (stored) =>
            Effect.gen(function* () {
              if (stored.small !== null) yield* registerPublicFile(stored.small);
              if (stored.large !== null) yield* registerPublicFile(stored.large);
              const created = yield* createArticle(
                articleInput(data, { small: stored.small?.key, large: stored.large?.key }),
              );
              return created.notice;
            }),
        ),
    ),
  );

export const publishArticle = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.flatMap(decodeArticleId(Number(text(data, "id"))), (articleId) =>
        setArticlePublished(articleId, checkbox(data, "published")),
      ).pipe(Effect.as(SAVED)),
    ),
  );

// ---------------------------------------------------------------- C6

export const saveSponsor = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    readFile(data, "logo").then((logo) =>
      runPreparedCommand(requestScope(context), storeOptional(logo, "image"), (stored) =>
        Effect.gen(function* () {
          if (stored !== null) yield* registerPublicFile(stored);
          yield* createSponsor(sponsorInput(data, stored?.key ?? null));
          return SAVED;
        }),
      ),
    ),
  );

// ---------------------------------------------------------------- C8

export const saveSocialEvent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), Effect.as(createSocialEvent(socialEventInput(data)), SAVED)),
  );
