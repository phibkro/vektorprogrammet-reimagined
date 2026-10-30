import { PersonalDataRpcs } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import { Text, formSchema, wholeNumber } from "./formSchema";
import type { FormText } from "./formSchema";

/** What the domain's alumni payloads take of a click: the one box that was clicked, and nothing for the other. */
interface Clicked {
  readonly keepDetails?: boolean;
  readonly news?: boolean;
}

const booleanOf = (answer: string | undefined): boolean | undefined => {
  if (answer === "yes") {
    return true;
  }

  return answer === "no" ? false : undefined;
};

/**
 * One click on one question: `kind` names the box and `answer` is `yes` or `no`. Anything else answers nothing, and
 * the domain says that one question must be answered.
 */
export const answersOf = (text: FormText): Clicked => {
  const answer = booleanOf(text.answer);

  if (answer === undefined) {
    return {};
  }

  if (text.kind === "keepDetails") {
    return { keepDetails: answer };
  }

  return text.kind === "news" ? { news: answer } : {};
};

const ClickStrings = { answer: Text, kind: Text };

/** Min side: the signed-in person answers a box. */
export const AnswerOwnConsentForm = formSchema(
  Schema.Struct({ ...ClickStrings, personId: Text }),
  PersonalDataRpcs.setAlumniConsent.payloadSchema,
  (text) => ({ ...answersOf(text), personId: wholeNumber(text.personId) })
);

/** The page of the alumni e-mail: the code is the credential, and nobody signs in. */
export const AnswerConsentByCodeForm = formSchema(
  Schema.Struct({ ...ClickStrings, code: Text }),
  PersonalDataRpcs.answerAlumniConsent.payloadSchema,
  (text) => ({ ...answersOf(text), code: text.code ?? "" })
);

/** An erasure of one person's data. */
export const ErasePersonForm = formSchema(
  Schema.Struct({ personId: Text }),
  PersonalDataRpcs.erasePerson.payloadSchema,
  (text) => ({ personId: wholeNumber(text.personId) })
);

/** Two records of one person become one. */
export const MergePersonsForm = formSchema(
  Schema.Struct({ from: Text, into: Text }),
  PersonalDataRpcs.mergePersons.payloadSchema,
  (text) => ({
    from: wholeNumber(text.from),
    into: wholeNumber(text.into),
  })
);
