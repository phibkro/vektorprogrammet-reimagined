/**
 * The machines of the kernel that its descriptions export, each with the schema of the context that its guards read.
 * The conformance test fails for a machine that a description exports and that is not here, and for one that is here and
 * that no description exports, so a machine cannot be left unchecked by being forgotten.
 */
import { Teams } from "@vektorprogrammet/domain";

import { machineUnderTest } from "./conformance.ts";

export const machines = [
  machineUnderTest({
    context: Teams.MembershipMoment,
    table: Teams.MembershipMachine,
  }),
];
