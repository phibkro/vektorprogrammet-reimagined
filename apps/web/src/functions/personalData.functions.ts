/**
 * Server functions of the personal data rights (spec 0007b): the answer to a consent question, from Min side and from the
 * link of the alumni e-mail, and the erasure. Each runs one command through `runCommand`; the rules are the domain's.
 */
import { createServerFn } from "@tanstack/react-start";
import { Schema } from "effect";

import {
  answerConsentByCodeProgram,
  answerOwnConsentProgram,
  erasePersonProgram,
} from "../server/personalData";
import { runCommand } from "../server/runtime";
import { requestScope } from "../server/scope";

const formData = Schema.toStandardSchemaV1(Schema.FormData);

export const answerOwnConsent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), answerOwnConsentProgram(data))
  );

/** Public: the code in the form is the credential, so a visitor who is not signed in can answer. */
export const answerConsentByCode = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), answerConsentByCodeProgram(data))
  );

export const erasePersonData = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), erasePersonProgram(data))
  );
