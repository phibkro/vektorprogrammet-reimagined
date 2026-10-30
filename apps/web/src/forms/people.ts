import { Accounts } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import { Text, blankToNull, formSchema, wholeNumber } from "./formSchema";

const personOf = (text: Readonly<Record<string, string | undefined>>) => ({
  personId: wholeNumber(text.personId),
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
  (text) => ({
    companyEmail: blankToNull(text.companyEmail),
    email: text.email ?? "",
    fieldOfStudyId: wholeNumber(text.fieldOfStudyId),
    name: text.name ?? "",
    personId: wholeNumber(text.personId),
  })
);
