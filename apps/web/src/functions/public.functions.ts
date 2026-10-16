/**
 * Server functions for the public site. Each reads the request (outside
 * Effect), runs one page program through `runQuery`, and returns a
 * serializable `Outcome`. Safe to import from routes: the Start compiler
 * replaces handler bodies with RPC stubs on the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import {
  contactPage,
  articlePage,
  footerSponsors,
  homePage,
  newsPage,
  staticBlocks,
} from "../server/pages";
import { runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";

const StaticPageInput = Schema.toStandardSchemaV1(
  Schema.Struct({ page: Schema.Literals(["omvektor", "foreldre"]) })
);

const NewsInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    department: Schema.NullOr(Schema.String),
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  })
);

const SlugInput = Schema.toStandardSchemaV1(
  Schema.Struct({ slug: Schema.String })
);

const ContactInput = Schema.toStandardSchemaV1(
  Schema.Struct({ sentTo: Schema.NullOr(Schema.Int) })
);

export const getHomePage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), homePage)
);

export const getStaticPage = createServerFn({ method: "GET" })
  .validator(StaticPageInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), staticBlocks(data.page))
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

/** `/kontakt` and `/kontakt/avdeling/{id}`: departments, the header block, the receipt, the Turnstile site key. */
export const getContactPage = createServerFn({ method: "GET" })
  .validator(ContactInput)
  .handler(({ context, data }) =>
    runQuery(
      requestScope(context),
      Effect.map(contactPage(data.sentTo), (page) => ({
        ...page,
        turnstileSiteKey: context.env.TURNSTILE_SITE_KEY,
      }))
    )
  );
