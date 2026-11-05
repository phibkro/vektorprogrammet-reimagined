import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSignInDestination } from "../features/accounts/server/functions";
import { pageData } from "../http/outcome";

export const Route = createFileRoute("/etter-innlogging")({
  loader: () =>
    getSignInDestination().then((result) => {
      const destination = pageData(result);
      throw redirect({ to: destination });
    }),
});
