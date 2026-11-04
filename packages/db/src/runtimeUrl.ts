import { Array as Arr, Redacted } from "effect";

/** Reject database administrator credentials and connection-option overrides at the Worker boundary. */
export const runtimeDatabaseUrl = (value: string): Redacted.Redacted => {
  if (!URL.canParse(value)) {
    throw new Error("DATABASE_URL is invalid");
  }
  const url = new URL(value);
  const validUser = /^vektor_runtime(?:\.[a-z0-9]+)?$/u.test(url.username);

  const validOptions =
    Arr.every(
      [...url.searchParams],
      ([key, option]) =>
        key === "sslmode" &&
        [
          "disable",
          "allow",
          "prefer",
          "require",
          "verify-ca",
          "verify-full",
        ].includes(option)
    ) && url.searchParams.getAll("sslmode").length <= 1;

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !validUser ||
    url.hostname === "" ||
    url.hash !== "" ||
    !validOptions
  ) {
    throw new Error(
      "DATABASE_URL must use restricted runtime credentials without connection overrides"
    );
  }

  return Redacted.make(value);
};
