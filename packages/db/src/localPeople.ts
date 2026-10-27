/**
 * Fake identities for local development, Preview and browser tests. The local test-actor cookie selects by name;
 * Ada, Lise and Nora also have fake sign-in credentials. Mats starts without an account for the invitation journey.
 */
export const LOCAL_PEOPLE = [
  "Ada Admin",
  "Lise Leder",
  "Mats Medlem",
  "Sofie Styre",
  "Nora Nybegynner",
  "Eva Ekstern",
] as const;

export type LocalPerson = (typeof LOCAL_PEOPLE)[number];

export const DEFAULT_LOCAL_PERSON: LocalPerson = "Ada Admin";

/** Public fixture password, used only for fake local/preview accounts. */
export const LOCAL_FAKE_PASSWORD = "vektor-test-passord";
