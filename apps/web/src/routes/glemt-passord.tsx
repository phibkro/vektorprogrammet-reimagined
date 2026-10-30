import { Turnstile } from "@marsidev/react-turnstile";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { PostForm } from "@/components/form/postForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RequestResetForm } from "@/forms/account";
import { getResetSiteKey } from "@/functions/account.functions";
import { validateContactSearch } from "@/lib/contactSearch";
import { fieldErrors } from "@/lib/outcome";

const routeApi = getRouteApi("/glemt-passord");

const ForgotPassword = () => {
  const siteKey = routeApi.useLoaderData();
  const { sendt } = routeApi.useSearch();

  return (
    <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Glemt passord</CardTitle>
        </CardHeader>
        <CardContent>
          {sendt === 1 ? (
            <p role="status">Hvis en konto finnes, har vi sendt en lenke.</p>
          ) : (
            <PostForm
              action="/api/account/request-reset"
              className="grid gap-4"
              defaults={{ email: "" }}
              schema={RequestResetForm.schema}
              serverIssues={fieldErrors(null)}
            >
              {(Field) => (
                <>
                  <Field label="Privat e-post" name="email">
                    <Input
                      autoComplete="email"
                      id="email"
                      required
                      type="email"
                    />
                  </Field>
                  <Turnstile siteKey={siteKey} />
                  <Button type="submit">Send lenke</Button>
                </>
              )}
            </PostForm>
          )}
          <a href="/logg-inn">Tilbake til innlogging</a>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/glemt-passord")({
  component: ForgotPassword,
  loader: () => getResetSiteKey(),
  validateSearch: validateContactSearch,
});
