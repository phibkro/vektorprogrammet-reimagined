import type { ExecutionContext } from "@cloudflare/workers-types";

import type {
  ApplicationFormState,
  VerifyState,
} from "../../features/admission/formState";
import type { ContactFormState } from "../../features/contact/formState";
import type { WorkerEnv } from "./env";

export interface RequestContext {
  readonly env: WorkerEnv;
  readonly ctx: ExecutionContext;
  readonly applicationForm?: ApplicationFormState;
  readonly contactForm?: ContactFormState;
  readonly verify?: VerifyState;
}

declare module "@tanstack/react-router" {
  interface Register {
    server: { requestContext: RequestContext };
  }
}
