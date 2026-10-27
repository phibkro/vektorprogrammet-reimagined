/**
 * The Norwegian words the control panel uses for the teams domain (client-safe: the browser imports it). The
 * domain's own names are English (GLOSSARY.md); these are what a person reads.
 */
import type { MembershipState, TeamFunction } from "@vektorprogrammet/domain";

export const TEAM_FUNCTION_LABEL: Readonly<Record<TeamFunction, string>> = {
  board: "Styret",
  economy: "Økonomi",
  it: "IT",
  other: "Annet",
  placement: "Plassering",
  recruitment: "Rekruttering",
};

export const MEMBERSHIP_STATE_LABEL: Readonly<Record<MembershipState, string>> =
  {
    Active: "Aktiv",
    Ended: "Avsluttet",
    Planned: "Planlagt",
  };
