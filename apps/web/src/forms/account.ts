import {
  Accounts,
  EmailAddressInput,
  Password,
  REQUIRED_FIELD_MESSAGE,
} from "@vektorprogrammet/domain";
import { Schema } from "effect";

import { Text, formSchema } from "./formSchema";

/** A password that is typed to be checked by the account's own library, not chosen: it only has to be there. */
const Typed = Schema.String.check(
  Schema.isNonEmpty({ message: REQUIRED_FIELD_MESSAGE })
);

/** Sign-in (Better Auth): an address and a password. No policy applies: the library says if they are wrong. */
export const SignInForm = formSchema(
  Schema.Struct({ email: Text, password: Text, remember: Text }),
  Schema.Struct({
    email: EmailAddressInput,
    password: Typed,
    remember: Schema.Boolean,
  }),
  (text) => ({
    email: text.email ?? "",
    password: text.password ?? "",
    remember: text.remember !== undefined,
  })
);

/** Change password (Better Auth): the current password, and a new one that the domain's policy allows. */
export const ChangePasswordForm = formSchema(
  Schema.Struct({ currentPassword: Text, newPassword: Text }),
  Schema.Struct({ currentPassword: Typed, newPassword: Password }),
  (text) => ({
    currentPassword: text.currentPassword ?? "",
    newPassword: text.newPassword ?? "",
  })
);

/** `/glemt-passord`: the address that a reset link is asked for. */
export const RequestResetForm = formSchema(
  Schema.Struct({ email: Text }),
  Accounts.requestPasswordReset.payloadSchema,
  (text) => ({ email: text.email ?? "" })
);

/** `/aktiver` and `/nytt-passord`: the code of the link, and the password that is chosen with it. */
export const ChoosePasswordForm = formSchema(
  Schema.Struct({ code: Text, password: Text }),
  Accounts.resetPassword.payloadSchema,
  (text) => ({ code: text.code ?? "", password: text.password ?? "" })
);
