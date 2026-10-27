/**
 * The web side of personal data (spec 0007b): the form text of each command, the file that `exportMyData` makes and the
 * message that an erasure answers with. The rules, the texts and the commands are the domain's; nothing here decides.
 */
import {
  CurrentPrincipal,
  PersonalDataEndpoints,
  PersonalDataRpcs,
  PersonExport,
  personOf,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Predicate,
  Schema,
} from "effect";

import { text } from "../lib/formText";
import type { Outcome } from "../lib/outcome";
import { integer } from "./panel";

/** What every answer to a consent question says: the same words whichever way the person answered. */
const ANSWERED = "Svaret ditt er lagret.";

/** One click on one question: `kind` names the box and `answer` is `yes` or `no`. Anything else answers nothing. */
const ClickedAnswer = Schema.Struct({
  answer: Schema.Literals(["yes", "no"]),
  kind: Schema.Literals(["keepDetails", "news"]),
});

const decodeClick = Schema.decodeUnknownOption(ClickedAnswer);

/**
 * The answers of one click, as the command's payload takes them: only the box that was clicked, so the other stays as
 * it was. A form that names no box or no answer gives none, and the domain says that one question must be answered.
 */
export const consentAnswers = (form: FormData) =>
  Option.match(
    decodeClick({ answer: text(form, "answer"), kind: text(form, "kind") }),
    {
      onNone: () => ({}),
      onSome: ({ answer, kind }) => ({ [kind]: answer === "yes" }),
    }
  );

/** Min side: the signed-in person answers a box. */
export const answerOwnConsentProgram = (form: FormData) =>
  Effect.as(
    PersonalDataEndpoints.setAlumniConsent({
      ...consentAnswers(form),
      personId: integer(text(form, "personId")),
    }),
    ANSWERED
  );

/** The answer page of the e-mail: the code is the credential, and nobody signs in. */
export const answerConsentByCodeProgram = (form: FormData) =>
  Effect.as(
    PersonalDataEndpoints.answerAlumniConsent({
      ...consentAnswers(form),
      code: text(form, "code"),
    }),
    ANSWERED
  );

const heldWords = ({
  reason,
  until,
}: PersonalDataRpcs.ErasureResult["held"][number]) =>
  until === null
    ? reason
    : `${reason} (til ${DateTime.formatIsoDateUtc(until)})`;

/** What an erasure tells the person: that it is done, and what the law keeps, with the date it ends. */
export const erasureMessage = ({
  erased,
  held,
}: PersonalDataRpcs.ErasureResult): string => {
  if (Arr.isReadonlyArrayNonEmpty(held)) {
    return `Opplysningene dine er slettet, bortsett fra det vi må beholde: ${Arr.join(Arr.map(held, heldWords), "; ")}.`;
  }

  return erased
    ? "Opplysningene dine er slettet. Du er logget ut."
    : "Det var ingenting mer å slette.";
};

export const erasePersonProgram = (form: FormData) =>
  Effect.map(
    PersonalDataEndpoints.erasePerson({
      personId: integer(text(form, "personId")),
    }),
    erasureMessage
  );

/** The control panel: an administrator merges two records of one person. */
export const mergePersonsProgram = (form: FormData) =>
  Effect.as(
    PersonalDataEndpoints.mergePersons({
      from: integer(text(form, "from")),
      into: integer(text(form, "into")),
    }),
    "Personene er slått sammen."
  );

/** The file of a person's own data: the name it is saved under and its JSON text. */
export const exportOwnFile = Effect.gen(function* exportOwnFile() {
  const personId = personOf(yield* CurrentPrincipal);

  if (personId === null) {
    return yield* PersonalDataRpcs.PersonalDataDomain.forbidden("exportMyData");
  }

  const exported = yield* PersonalDataEndpoints.exportMyData({ personId });

  // The domain's own value always encodes: a failure here is a defect, never a refusal.
  const body = yield* Effect.orDie(
    Schema.encodeEffect(Schema.fromJsonString(PersonExport, { space: 2 }))(
      exported
    )
  );

  return { body, filename: `vektorprogrammet-mine-data-${personId}.json` };
});

/**
 * The download: the file as an attachment, never cached, or the refusal as any command's refusal is shown. The browser
 * saves what a form post gets back with `Content-Disposition`.
 */
export const exportResponse = (
  outcome: Outcome<Effect.Success<typeof exportOwnFile>>
): Response =>
  Predicate.isTagged(outcome, "Success")
    ? new Response(outcome.value.body, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${outcome.value.filename}"`,
          "content-type": "application/json; charset=utf-8",
        },
      })
    : new Response(outcome.message, { status: outcome.status });
