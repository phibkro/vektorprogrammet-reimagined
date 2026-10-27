/** The one user-agent projection used by the sessions card. Bowser is the parser used by better-auth-ui. */
import { parse } from "bowser";
import { Match } from "effect";

type DeviceKind = "desktop" | "phone" | "tablet" | "unknown";

export interface SessionClient {
  readonly browser: string;
  readonly system: string;
  readonly device: DeviceKind;
}

export const sessionClient = (userAgent: string | null): SessionClient => {
  if (userAgent === null || userAgent === "") {
    return {
      browser: "Ukjent nettleser",
      device: "unknown",
      system: "Ukjent system",
    };
  }

  const parsed = parse(userAgent);

  const device: DeviceKind = Match.value(parsed.platform.type).pipe(
    Match.when("mobile", () => "phone" as const),
    Match.when("tablet", () => "tablet" as const),
    Match.when("desktop", () => "desktop" as const),
    Match.orElse(() => "unknown" as const)
  );

  return {
    browser: parsed.browser.name ?? "Ukjent nettleser",
    device,
    system: parsed.os.name ?? "Ukjent system",
  };
};
