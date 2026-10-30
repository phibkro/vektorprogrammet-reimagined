/**
 * Spec 0010a F2: the browser and the server say the same thing about the same values. The browser validates the values of
 * a form with the form's schema (`clientValidator`); the server reads the posted `FormData` with the form's `read`, and
 * the command's endpoint decodes it with the command's payload schema (`decodeInput`). For values that are wrong in
 * several ways the two give the same issues, with the same paths and the same Norwegian words, because both read the same
 * payload schema behind the same text step. The control is a form whose payload is not the command's: the comparison
 * reports it.
 */
import { assert, describe, it } from "@effect/vitest";
import type { ValidationFailed } from "@vektorprogrammet/domain";
import {
  Accounts,
  Contact,
  Content,
  Organisation,
  PersonalDataRpcs,
  Teams,
  decodeInput,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Order, Predicate, Schema } from "effect";

import { ChoosePasswordForm, RequestResetForm } from "../src/forms/account";
import { ContactForm } from "../src/forms/contact";
import { DepartmentForm } from "../src/forms/department";
import {
  Text,
  clientValidator,
  formSchema,
  toFormData,
} from "../src/forms/formSchema";
import type { FormText } from "../src/forms/formSchema";
import { SocialEventForm } from "../src/forms/organisation";
import { AnswerOwnConsentForm } from "../src/forms/personalData";
import { AddMemberForm, GrantAdminForm } from "../src/forms/teams";

/** An issue as a person reads it: where, and what it says. */
const asText = (path: readonly string[], message: string): string =>
  `${Arr.join(path, ".")}: ${message}`;

/** The two sides of a form: what its schema gives the browser, and what it reads from a post. */
interface Form {
  readonly read: (form: FormData) => object;
  readonly schema: Schema.ConstraintDecoder<unknown>;
}

/** What the browser says of these values: the Standard Schema issues of the form's own schema. */
const browserSays = (form: Form, text: FormText) =>
  Effect.promise(() =>
    Promise.resolve(clientValidator(form.schema)["~standard"].validate(text))
  ).pipe(
    Effect.map((result) =>
      Arr.sort(
        Predicate.hasProperty(result, "issues")
          ? Arr.map(result.issues ?? [], (issue) =>
              asText(
                Arr.map(issue.path ?? [], (segment) =>
                  String(Predicate.isObject(segment) ? segment.key : segment)
                ),
                issue.message
              )
            )
          : [],
        Order.String
      )
    )
  );

/** What the server says of the same values, posted: the form's `read`, then the command's own payload decoder. */
const serverSays = <P extends Schema.Constraint>(
  form: Form,
  payload: P,
  text: FormText
) =>
  decodeInput(payload)(form.read(toFormData(text))).pipe(
    Effect.match({
      onFailure: (failure: ValidationFailed) =>
        Arr.sort(
          Arr.map(failure.issues, (issue) => asText(issue.path, issue.message)),
          Order.String
        ),
      onSuccess: () => [],
    })
  );

const longName = "x".repeat(300);

/** Values that are wrong in several ways, for forms of every kind in the app. */
const CASES = [
  {
    form: DepartmentForm,
    name: "department",
    payload: Organisation.createDepartment.payloadSchema,
    text: {
      city: "",
      email: "ikke-en-adresse",
      latitude: "abc",
      name: longName,
      shortName: "",
    },
  },
  {
    form: ContactForm,
    name: "contact",
    payload: Contact.submitContact.payloadSchema,
    text: {
      departmentId: "x",
      email: "nope",
      message: "",
      name: "",
      subject: "",
    },
  },
  {
    form: AddMemberForm,
    name: "add member",
    payload: Teams.createMembership.payloadSchema,
    text: { personId: "", positionId: "7", start: "Høst 2026", teamId: "1" },
  },
  {
    form: GrantAdminForm,
    name: "admin place",
    payload: Teams.createAdminGrant.payloadSchema,
    text: { personId: "3", until: "i morgen" },
  },
  {
    form: SocialEventForm,
    name: "social event",
    payload: Content.createSocialEvent.payloadSchema,
    text: {
      departmentId: "1",
      description: "",
      endsAt: "2030-01-01T10:00",
      semesterId: "1",
      startsAt: "2030-01-01T12:00",
      title: "",
    },
  },
  {
    form: ChoosePasswordForm,
    name: "choose password",
    payload: Accounts.resetPassword.payloadSchema,
    text: { code: "", password: "kort" },
  },
  {
    form: AnswerOwnConsentForm,
    name: "consent without an answer",
    payload: PersonalDataRpcs.setAlumniConsent.payloadSchema,
    text: { personId: "3" },
  },
] as const;

describe("spec 0010a F2: the browser and the server agree", () => {
  for (const { form, name, payload, text } of CASES) {
    it.effect(`${name}: the same issues, the same paths, the same words`, () =>
      Effect.gen(function* compare() {
        const browser = yield* browserSays(form, text);
        const server = yield* serverSays(form, payload, text);

        assert.isAbove(server.length, 0);
        assert.deepStrictEqual(browser, server);
      })
    );
  }

  it.effect(
    "control: a form whose payload is not the command's is told apart from the server",
    () =>
      Effect.gen(function* control() {
        const lax = formSchema(
          Schema.Struct({ email: Text }),
          Schema.Struct({ email: Schema.String }),
          (values) => ({ email: values.email ?? "" })
        );

        const text = { email: "nope" };
        const browser = yield* browserSays(lax, text);

        const server = yield* serverSays(
          RequestResetForm,
          Accounts.requestPasswordReset.payloadSchema,
          text
        );

        assert.deepStrictEqual(browser, []);
        assert.isAbove(server.length, 0);
        assert.notDeepEqual(browser, server);
      })
  );
});
