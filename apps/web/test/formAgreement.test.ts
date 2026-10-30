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
import {
  Array as Arr,
  Effect,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import * as AccountForms from "../src/forms/account";
import * as ContactForms from "../src/forms/contact";
import * as DepartmentForms from "../src/forms/department";
import {
  Text,
  clientValidator,
  formSchema,
  toFormData,
} from "../src/forms/formSchema";
import type { FormText } from "../src/forms/formSchema";
import * as OrganisationForms from "../src/forms/organisation";
import * as PeopleForms from "../src/forms/people";
import * as PersonalDataForms from "../src/forms/personalData";
import * as TeamForms from "../src/forms/teams";

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
    form: DepartmentForms.DepartmentForm,
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
    form: ContactForms.ContactForm,
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
    form: TeamForms.AddMemberForm,
    name: "add member",
    payload: Teams.createMembership.payloadSchema,
    text: { personId: "", positionId: "7", start: "Høst 2026", teamId: "1" },
  },
  {
    form: TeamForms.GrantAdminForm,
    name: "admin place",
    payload: Teams.createAdminGrant.payloadSchema,
    text: { personId: "3", until: "i morgen" },
  },
  {
    form: OrganisationForms.SocialEventForm,
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
    form: AccountForms.ChoosePasswordForm,
    name: "choose password",
    payload: Accounts.resetPassword.payloadSchema,
    text: { code: "", password: "kort" },
  },
  {
    form: PersonalDataForms.AnswerOwnConsentForm,
    name: "consent without an answer",
    payload: PersonalDataRpcs.setAlumniConsent.payloadSchema,
    text: { personId: "3" },
  },
  {
    form: AccountForms.RequestResetForm,
    name: "request a reset",
    payload: Accounts.requestPasswordReset.payloadSchema,
    text: { email: "nope" },
  },
  {
    form: OrganisationForms.CreateFieldOfStudyForm,
    name: "create a field of study",
    payload: Organisation.createFieldOfStudy.payloadSchema,
    text: { departmentId: "x", name: "", shortName: "" },
  },
  {
    form: OrganisationForms.RenameFieldOfStudyForm,
    name: "rename a field of study",
    payload: Organisation.updateFieldOfStudy.payloadSchema,
    text: { id: "x", name: "", shortName: "" },
  },
  {
    form: PeopleForms.InviteAccountForm,
    name: "invite an account",
    payload: Accounts.createAccount.payloadSchema,
    text: { personId: "x" },
  },
  {
    form: PeopleForms.DeactivateAccountForm,
    name: "deactivate an account",
    payload: Accounts.deactivateAccount.payloadSchema,
    text: { personId: "x" },
  },
  {
    form: PeopleForms.ReactivateAccountForm,
    name: "reactivate an account",
    payload: Accounts.reactivateAccount.payloadSchema,
    text: { personId: "x" },
  },
  {
    form: PeopleForms.UpdateProfileForm,
    name: "update a profile",
    payload: Accounts.updatePerson.payloadSchema,
    text: {
      companyEmail: "nope",
      email: "nope",
      fieldOfStudyId: "x",
      name: "",
      personId: "x",
    },
  },
  {
    form: PersonalDataForms.AnswerConsentByCodeForm,
    name: "consent by code without an answer",
    payload: PersonalDataRpcs.answerAlumniConsent.payloadSchema,
    text: { code: "" },
  },
  {
    form: PersonalDataForms.ErasePersonForm,
    name: "erase a person",
    payload: PersonalDataRpcs.erasePerson.payloadSchema,
    text: { personId: "x" },
  },
  {
    form: PersonalDataForms.MergePersonsForm,
    name: "merge persons",
    payload: PersonalDataRpcs.mergePersons.payloadSchema,
    text: { from: "x", into: "" },
  },
  {
    form: TeamForms.CreateTeamForm,
    name: "create a team",
    payload: Teams.createTeam.payloadSchema,
    text: {
      defaultTerm: "x",
      departmentId: "x",
      function: "",
      groupEmail: "nope",
      name: "",
    },
  },
  {
    form: TeamForms.UpdateTeamForm,
    name: "update a team",
    payload: Teams.updateTeam.payloadSchema,
    text: {
      defaultTerm: "x",
      function: "",
      groupEmail: "nope",
      id: "x",
      name: "",
    },
  },
  {
    form: TeamForms.DeactivateTeamForm,
    name: "deactivate a team",
    payload: Teams.deactivateTeam.payloadSchema,
    text: { id: "x" },
  },
  {
    form: TeamForms.RegisterPersonForm,
    name: "register a person",
    payload: Teams.createPerson.payloadSchema,
    text: {
      companyEmail: "nope",
      email: "nope",
      fieldOfStudyId: "x",
      name: "",
    },
  },
  {
    form: TeamForms.ExtendMembershipForm,
    name: "extend a membership",
    payload: Teams.extendMembership.payloadSchema,
    text: { end: "i morgen", id: "x" },
  },
  {
    form: TeamForms.ChangeMembershipForm,
    name: "change a membership",
    payload: Teams.changeMembership.payloadSchema,
    text: { from: "nei", id: "x", leader: "", positionId: "x" },
  },
  {
    form: TeamForms.EndMembershipForm,
    name: "end a membership",
    payload: Teams.endEarlyMembership.payloadSchema,
    text: { id: "x", semester: "nei" },
  },
  {
    form: TeamForms.CancelMembershipForm,
    name: "cancel a membership",
    payload: Teams.deleteMembership.payloadSchema,
    text: { id: "x" },
  },
  {
    form: TeamForms.RevokeAdminForm,
    name: "revoke an admin place",
    payload: Teams.deleteAdminGrant.payloadSchema,
    text: { id: "x" },
  },
] as const;

/**
 * The forms that no command's payload backs, each with its reason: a sign-in is Better Auth's, a password change is
 * Better Auth's too (its schema is local), and a form without inputs has nothing to disagree about.
 */
const WITHOUT_A_COMMAND: readonly Form[] = [
  AccountForms.SignInForm,
  AccountForms.ChangePasswordForm,
  OrganisationForms.NoFieldsForm,
];

const isForm = (value: unknown): value is Form =>
  Predicate.hasProperty(value, "payloadOf") &&
  Predicate.hasProperty(value, "read") &&
  Predicate.hasProperty(value, "schema");

/** Every form that the app builds with `formSchema`: the exports of `src/forms` that carry the construct's members. */
const EVERY_FORM: readonly Form[] = Arr.filter(
  [
    ...Rec.values(AccountForms),
    ...Rec.values(ContactForms),
    ...Rec.values(DepartmentForms),
    ...Rec.values(OrganisationForms),
    ...Rec.values(PeopleForms),
    ...Rec.values(PersonalDataForms),
    ...Rec.values(TeamForms),
  ],
  isForm
);

/** The forms that are neither compared in `cases` nor excused: nothing else keeps a new form in agreement with its command. */
const uncovered = (
  forms: readonly Form[],
  cases: readonly { readonly form: Form }[],
  excused: readonly Form[]
): readonly Form[] =>
  Arr.filter(
    forms,
    (form) =>
      !Arr.some(cases, (row) => row.form === form) &&
      !Arr.contains(excused, form)
  );

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
          AccountForms.RequestResetForm,
          Accounts.requestPasswordReset.payloadSchema,
          text
        );

        assert.deepStrictEqual(browser, []);
        assert.isAbove(server.length, 0);
        assert.notDeepEqual(browser, server);
      })
  );

  it("issue 74: every form of src/forms is compared above or excused, so a new form cannot join unchecked", () => {
    assert.isAbove(EVERY_FORM.length, 20);
    assert.strictEqual(
      uncovered(EVERY_FORM, CASES, WITHOUT_A_COMMAND).length,
      0
    );
  });

  it("issue 74 control: a form with no row and no excuse is reported", () => {
    const [lonely] = EVERY_FORM;
    assert.isDefined(lonely);

    const rows = Arr.filter(CASES, (row) => row.form !== lonely);

    assert.deepStrictEqual(uncovered([lonely], rows, []), [lonely]);
  });
});
