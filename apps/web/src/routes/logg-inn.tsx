import { createFileRoute } from "@tanstack/react-router";

import { AuthProvider } from "@/components/auth/authProvider";
import { SignIn } from "@/components/auth/signIn";

const SignInPage = () => (
  <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
    <AuthProvider>
      <SignIn />
    </AuthProvider>
  </main>
);

export const Route = createFileRoute("/logg-inn")({ component: SignInPage });
