import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { requestScope } from "../../../server/http/scope";
import { runCommand, runQuery } from "../../../server/runtime";
import { SAVED } from "../../organisation/server/organisation";
import {
  DeactivateAccountForm,
  InviteAccountForm,
  ReactivateAccountForm,
  UpdateProfileForm,
} from "../../teams/forms/people";
import { AccountEndpoints } from "../domain/commands";
import { myPage, signInDestination } from "./accounts";

const formData = Schema.toStandardSchemaV1(Schema.FormData);

export const getMyPage = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), myPage)
);

export const getSignInDestination = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), signInDestination)
);

/** Turnstile's site key is public; verification uses the Worker secret. */
export const getResetSiteKey = createServerFn({ method: "GET" }).handler(
  ({ context }) => context.env.TURNSTILE_SITE_KEY
);

export const inviteAccount = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(
        AccountEndpoints.createAccount(InviteAccountForm.read(data)),
        "Invitasjonen er lagt til for sending."
      )
    )
  );

export const deactivateAccount = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(
        AccountEndpoints.deactivateAccount(DeactivateAccountForm.read(data)),
        SAVED
      )
    )
  );

export const reactivateAccount = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(
        AccountEndpoints.reactivateAccount(ReactivateAccountForm.read(data)),
        SAVED
      )
    )
  );

export const updateProfile = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(
      requestScope(context),
      Effect.as(
        AccountEndpoints.updatePerson(UpdateProfileForm.read(data)),
        SAVED
      )
    )
  );
