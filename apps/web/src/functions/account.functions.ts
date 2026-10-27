import { createServerFn } from "@tanstack/react-start";
import { AccountEndpoints } from "@vektorprogrammet/domain";
import { Effect, Schema } from "effect";

import { text } from "../lib/formText";
import { myPage, signInDestination } from "../server/accounts";
import { SAVED, integer, optionalText } from "../server/panel";
import { runCommand, runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";

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
        AccountEndpoints.createAccount({
          personId: integer(text(data, "personId")),
        }),
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
        AccountEndpoints.deactivateAccount({
          personId: integer(text(data, "personId")),
        }),
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
        AccountEndpoints.reactivateAccount({
          personId: integer(text(data, "personId")),
        }),
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
        AccountEndpoints.updatePerson({
          companyEmail: optionalText(data, "companyEmail"),
          email: text(data, "email"),
          fieldOfStudyId: integer(text(data, "fieldOfStudyId")),
          name: text(data, "name"),
          personId: integer(text(data, "personId")),
        }),
        SAVED
      )
    )
  );
