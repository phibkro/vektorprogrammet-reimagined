import { createFileRoute } from "@tanstack/react-router";

import { SignIn } from "../features/accounts/components/signIn";

const SignInPage = () => (
  <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
    <SignIn />
  </main>
);

export const Route = createFileRoute("/logg-inn")({ component: SignInPage });
