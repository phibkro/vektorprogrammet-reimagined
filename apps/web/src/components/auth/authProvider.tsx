/** Adapted from the better-auth-ui base-nova registry (MIT); only the shared query provider is needed here. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";

export const AuthProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [client] = useState(() => new QueryClient());

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
