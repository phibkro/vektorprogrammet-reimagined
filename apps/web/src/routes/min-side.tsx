import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import { Predicate } from "effect";
import { useState } from "react";

import { ActiveSessions } from "@/components/auth/settings/security/activeSessions";
import { ChangePassword } from "@/components/auth/settings/security/changePassword";
import { ConsentQuestions } from "@/components/consentQuestions";
import { CommandForm } from "@/components/forms";
import { OwnData } from "@/components/ownData";
import { ProfileFields } from "@/components/profileFields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMyPage, updateProfile } from "@/functions/account.functions";
import { answerOwnConsent } from "@/functions/personalData.functions";
import { authRequest } from "@/lib/authClient";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/min-side");

const SignOut = () => {
  const navigate = useNavigate();

  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <>
      <Button
        disabled={pending}
        onClick={() => {
          setPending(true);
          void authRequest("sign-out").then(
            () => navigate({ to: "/logg-inn" }),
            () => {
              setFailed(true);
              setPending(false);
            }
          );
        }}
        type="button"
        variant="outline"
      >
        Logg ut
      </Button>
      {failed && <p role="alert">Kunne ikke logge ut.</p>}
    </>
  );
};

const MyPage = () => {
  const page = routeApi.useLoaderData();

  if (Predicate.isTagged(page, "Anonymous")) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <h1>Ikke innlogget</h1>
        <a href="/logg-inn">Logg inn</a>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-3xl gap-6 px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Min side</h1>
        <SignOut />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Profil</CardTitle>
        </CardHeader>
        <CardContent>
          <CommandForm action={updateProfile} submitLabel="Lagre profil">
            <input name="personId" type="hidden" value={page.person.id} />
            <ProfileFields
              fieldsOfStudy={page.fieldsOfStudy}
              profile={page.person}
            />
          </CommandForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Samtykker</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsentQuestions
            action={answerOwnConsent}
            answers={page.consents}
            credential={{ name: "personId", value: String(page.person.id) }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Opplysningene dine</CardTitle>
        </CardHeader>
        <CardContent>
          <OwnData personId={page.person.id} />
        </CardContent>
      </Card>
      <ActiveSessions />
      <ChangePassword />
    </main>
  );
};

export const Route = createFileRoute("/min-side")({
  component: MyPage,
  loader: () => getMyPage().then(pageData),
  staticData: { ownsPage: true },
});
