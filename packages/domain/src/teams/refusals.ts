/**
 * The Norwegian texts that the repositories of the teams domain refuse with, in one place so that `packages/db` and
 * the in-memory repositories of the tests say the same thing. The handlers' own refusals sit beside their code.
 */
export const PERSON_EXISTS =
  "En person med denne e-postadressen finnes allerede.";

export const TEAM_EXISTS =
  "Et team med dette navnet finnes allerede i avdelingen.";

export const MEMBERSHIP_OVERLAPS =
  "Personen har allerede et medlemskap i teamet som overlapper denne perioden.";

export const MEMBERSHIP_CHANGED =
  "Medlemskapet ble endret av noen andre. Last siden på nytt og prøv igjen.";
