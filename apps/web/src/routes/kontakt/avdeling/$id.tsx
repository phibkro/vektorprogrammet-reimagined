import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateContactSearch } from "../../../features/contact/contactSearch";
import type { ContactSearch } from "../../../features/contact/contactSearch";
import { getDepartmentSlug } from "../../../features/site/server/functions";
import { pageData } from "../../../http/outcome";

/**
 * `/kontakt/avdeling/{id}` was the legacy address of a department's contact page, and the contact form still
 * answers a post with 303 to it (`server/features/contactPost.ts` knows the department's id, not its city). It answers 301
 * to `/kontakt/{department}`, keeping `?sendt=1`. An id that is not an active department is 404.
 */
export const Route = createFileRoute("/kontakt/avdeling/$id")({
  loader: ({ params, deps }) =>
    getDepartmentSlug({
      data: { id: /^\d+$/u.test(params.id) ? Number(params.id) : null },
    })
      .then(pageData)
      .then((slug) => {
        throw redirect({
          params: { department: slug },
          search: deps,
          statusCode: 301,
          to: "/kontakt/$department",
        });
      }),
  loaderDeps: ({ search }: { readonly search: ContactSearch }) => search,
  validateSearch: validateContactSearch,
});
