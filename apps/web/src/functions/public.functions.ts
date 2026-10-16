/**
 * Server functions for the public site. Each reads the request (outside
 * Effect), runs one page program (`server/site/pages.ts`) through `runQuery`,
 * and returns a serializable `Outcome`. Safe to import from routes: the Start
 * compiler replaces handler bodies with RPC stubs on the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";
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
} from "../server/site/pages";

const NewsInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    department: Schema.NullOr(Schema.String),
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  })
);

const SlugInput = Schema.toStandardSchemaV1(
  Schema.Struct({ slug: Schema.String })
);

const OptionalSlugInput = Schema.toStandardSchemaV1(
  Schema.Struct({ slug: Schema.NullOr(Schema.String) })
);

const ContactInput = Schema.toStandardSchemaV1(
  Schema.Struct({ sent: Schema.Boolean, slug: Schema.NullOr(Schema.String) })
);

const DepartmentIdInput = Schema.toStandardSchemaV1(
  Schema.Struct({ id: Schema.NullOr(Schema.Int) })
);

export const getHomePage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), homePage)
);

export const getAboutPage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), aboutPage)
);

export const getAssistantsPage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), assistantsPage)
);

export const getTeamPage = createServerFn({ method: "GET" })
  .validator(OptionalSlugInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), teamPage(data.slug))
  );

export const getParentsPage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), parentsPage)
);

export const getSchoolsPage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), schoolsPage)
);

export const getNewsPage = createServerFn({ method: "GET" })
  .validator(NewsInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), newsPage(data))
  );

export const getArticlePage = createServerFn({ method: "GET" })
  .validator(SlugInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), articlePage(data.slug))
  );

export const getFooter = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), footerSponsors)
);

/** `/kontakt` and `/kontakt/{department}`: the departments, the header text, the receipt and the Turnstile site key. */
export const getContactPage = createServerFn({ method: "GET" })
  .validator(ContactInput)
  .handler(({ context, data }) =>
    runQuery(
      requestScope(context),
      Effect.map(contactPage(data.slug, data.sent), (page) => ({
        ...page,
        turnstileSiteKey: context.env.TURNSTILE_SITE_KEY,
      }))
    )
  );

/** The URL segment of a department by its legacy id: `/kontakt/avdeling/{id}` answers 301 to `/kontakt/{department}`. */
export const getDepartmentSlug = createServerFn({ method: "GET" })
  .validator(DepartmentIdInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), departmentSlugById(data.id))
  );
