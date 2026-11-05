import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import { Array as Arr, Predicate } from "effect";
import { useState } from "react";

import { CommandForm } from "@/components/form/commandForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { authRequest } from "../features/accounts/client";
import {
  ProfileFields,
  profileDefaults,
} from "../features/accounts/components/profileFields";
import { ActiveSessions } from "../features/accounts/components/settings/security/activeSessions";
import { ChangePassword } from "../features/accounts/components/settings/security/changePassword";
import {
  getMyPage,
  updateProfile,
} from "../features/accounts/server/functions";
import { ConsentQuestions } from "../features/personal-data/components/consentQuestions";
import { OwnData } from "../features/personal-data/components/ownData";
import { answerOwnConsent } from "../features/personal-data/server/functions";
import { UpdateProfileForm } from "../features/teams/forms/people";
import { pageData } from "../http/outcome";

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

  const fieldChoices = Arr.map(page.fieldsOfStudy, (field) => ({
    label: field.label,
    value: String(field.id),
  }));

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
          <CommandForm
            action={updateProfile}
            defaults={{
              ...profileDefaults(fieldChoices, page.person),
              personId: String(page.person.id),
            }}
            schema={UpdateProfileForm.schema}
            submitLabel="Lagre profil"
          >
            {(Field) => (
              <ProfileFields Field={Field} fieldsOfStudy={fieldChoices} />
            )}
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
