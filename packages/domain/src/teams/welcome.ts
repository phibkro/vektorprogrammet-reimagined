import { Array as Arr } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { EmailMessage } from "../shared/outbox.ts";
import type { DeclaredMessage } from "../shared/outbox.ts";
import type { Person, Position, Team } from "./entities.ts";

/**
 * RULE-248: two first-membership messages. Both go to the person's registered address: a Workspace account might not
 * exist yet, and a dry-run does not provision one. No password or unverified setup link is invented here.
 */
export const welcomeMessages = (
  person: Person,
  team: Team,
  position: Position
): NonEmptyReadonlyArray<DeclaredMessage> => {
  // Spec 0008 R2: switch this one recipient after a real Workspace account is provisioned.
  const setupRecipient = person.email;

  return [
    EmailMessage.make({
      replyTo: null,
      subject: `Velkommen til ${team.name}`,
      text: Arr.join(
        [
          `Hei ${person.name},`,
          "",
          `Velkommen til ${team.name} som ${position.name}.`,
          (person.companyEmail ?? null) === null
            ? "Vektor-eposten din er ikke registrert ennå. Ta kontakt med teamlederen din om tilgang."
            : `Din registrerte Vektor-epost er ${person.companyEmail}.`,
          "",
          "Hilsen Vektorprogrammet",
        ],
        "\n"
      ),
      to: person.email,
    }),
    EmailMessage.make({
      replyTo: null,
      subject: "Fullfør oppsettet med din Vektor-epost",
      text: Arr.join(
        [
          `Hei ${person.name},`,
          "",
          "Systemet har ikke opprettet en Vektor-konto ennå. Når kontoen er opprettet, kan teamlederen din hjelpe deg med oppsettet og tilgangen til organisasjonens verktøy.",
          "",
          "Hilsen Vektorprogrammet",
        ],
        "\n"
      ),
      to: setupRecipient,
    }),
  ];
};
