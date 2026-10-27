import { useSignOut } from "@better-auth-ui/react";
import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import { Predicate } from "effect";

import { AuthProvider } from "@/components/auth/authProvider";
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
import { authClient } from "@/lib/authClient";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/min-side");

const SignOut = () => {
  const navigate = useNavigate();

  const signOut = useSignOut(authClient, {
    onSuccess: () => {
      void navigate({ to: "/logg-inn" });
    },
  });

  return (
    <Button
      disabled={signOut.isPending}
      onClick={() => {
        signOut.mutate();
      }}
      type="button"
      variant="outline"
    >
      Logg ut
    </Button>
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
    <AuthProvider>
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
        <ActiveSessions
          currentSessionId={page.currentSessionId}
          sessions={page.sessions}
        />
        <ChangePassword />
      </main>
    </AuthProvider>
  );
};

export const Route = createFileRoute("/min-side")({
  component: MyPage,
  loader: () => getMyPage().then(pageData),
  staticData: { ownsPage: true },
});
