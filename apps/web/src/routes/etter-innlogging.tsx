import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSignInDestination } from "@/functions/account.functions";
import { pageData } from "@/lib/outcome";

export const Route = createFileRoute("/etter-innlogging")({
  loader: () =>
    getSignInDestination().then((result) => {
      const destination = pageData(result);
      throw redirect({ to: destination });
    }),
});
