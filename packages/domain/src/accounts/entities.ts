/** Account state is a domain fact; Better Auth owns credentials and sessions. */
import { Schema } from "effect";

import { PersonId } from "../shared/ids.ts";

export const AccountState = Schema.TaggedUnion({
  Active: {},
  Deactivated: {},
  Invited: {},
});

export type AccountState = typeof AccountState.Type;

export const Account = Schema.Struct({
  personId: PersonId,
  state: AccountState,
});

export type Account = typeof Account.Type;

const utf8 = new TextEncoder();

/** RULE-126, 166: one range for activation, changing and resetting a password. */
export const passwordAllowed = (password: string): boolean => {
  let characters = 0;

  for (const _character of password) {
    characters += 1;
  }

  return (
    characters >= 8 && characters <= 64 && utf8.encode(password).length <= 72
  );
};

export const Password = Schema.String.check(
  Schema.makeFilter(passwordAllowed, {
    message: "Passordet må ha 8–64 tegn og høyst 72 UTF-8-byte.",
  })
);
