/**
 * The people of the local seed (`test/support/localSeed.ts`, spec 0006). There is no sign-in before spec 0007, so the
 * local test actor is one of them, chosen by name; `vp dev` acts as `DEFAULT_LOCAL_PERSON` until a cookie chooses
 * another. The names are here, in the package root, because `apps/web` and its browser tests read them too; the seed
 * decides what each person is.
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
