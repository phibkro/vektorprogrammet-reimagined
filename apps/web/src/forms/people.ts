import { Accounts } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import { Text, blankToNull, formSchema, wholeNumber } from "./formSchema";
import type { FormText } from "./formSchema";

const personOf = (text: FormText) => ({
  personId: wholeNumber(text.personId),
});

/** The four values of a profile, as the commands that register a person and that change a profile take them. */
export const profileOf = (text: FormText) => ({
  companyEmail: blankToNull(text.companyEmail),
  email: text.email ?? "",
  fieldOfStudyId: wholeNumber(text.fieldOfStudyId),
  name: text.name ?? "",
});

/** A person who is invited to make an account. */
export const InviteAccountForm = formSchema(
  Schema.Struct({ personId: Text }),
  Accounts.createAccount.payloadSchema,
  personOf
);

/** An account that is deactivated. */
export const DeactivateAccountForm = formSchema(
  Schema.Struct({ personId: Text }),
  Accounts.deactivateAccount.payloadSchema,
  personOf
);

/** An account that is activated again. */
export const ReactivateAccountForm = formSchema(
  Schema.Struct({ personId: Text }),
  Accounts.reactivateAccount.payloadSchema,
  personOf
);

/** A person's profile: the one form of Min side, and of a leader who edits a person. */
export const UpdateProfileForm = formSchema(
  Schema.Struct({
    companyEmail: Text,
    email: Text,
    fieldOfStudyId: Text,
    name: Text,
    personId: Text,
  }),
  Accounts.updatePerson.payloadSchema,
  (text) => ({ ...profileOf(text), personId: wholeNumber(text.personId) })
);
