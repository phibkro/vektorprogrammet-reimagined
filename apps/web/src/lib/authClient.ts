import { createAuthClient } from "better-auth/react";

/** Same-origin client; all credential endpoints are owned by the web Worker. */
export const authClient = createAuthClient();
