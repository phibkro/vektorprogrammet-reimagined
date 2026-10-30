/**
 * The admission domain as data (spec 0009): the commands on admission periods and applications, who may run them, and
 * the stored machine of an application. An admission period has no machine of its own: its state is never stored, it is
 * `admissionState` of its dates and the clock (`organisation/admission.ts`), and the commands name the states they
 * accept in their text and check them in their handlers.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  anyone,
  grant,
  info,
  leader,
  make as declareDomain,
  self,
} from "../kernel/domain.ts";
import * as Machine from "../kernel/machine.ts";
import { fn } from "../kernel/subject.ts";
import { StoredAdmissionPeriod } from "../organisation/admission.ts";
import { Semester } from "../organisation/semester.ts";
import { isBefore } from "../shared/clock.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import {
  AdmissionPeriodId,
  ApplicationId,
  DepartmentId,
} from "../shared/ids.ts";
import {
  ApplicationState,
  RegisterApplicationInput,
  SubmitApplicationInput,
} from "./entities.ts";

export const END_AFTER_START = "Slutt må være etter start.";

/** What a staff member gives to schedule a period: the department, the semester it is for, and its window. */
export const AdmissionPeriodInput = Schema.Struct({
  departmentId: DepartmentId.annotate({
    message: "Velg avdeling.",
  }).annotateKey({ messageMissingKey: "Velg avdeling." }),
  end: Schema.DateTimeUtcFromString,
  semester: Semester,
  start: Schema.DateTimeUtcFromString,
}).check(
  Schema.makeFilter((period) =>
    isBefore(period.start, period.end)
      ? true
      : { issue: END_AFTER_START, path: ["end"] }
  )
);

/** What a submit or a registration answers: the application, and the department it is in. */
export const ApplicationReceipt = Schema.Struct({
  applicationId: ApplicationId,
  departmentId: DepartmentId,
});

export type ApplicationReceipt = typeof ApplicationReceipt.Type;

export const createAdmissionPeriod = Rpc.make("createAdmissionPeriod", {
  error: DomainErrorSchema,
  payload: AdmissionPeriodInput,
  success: StoredAdmissionPeriod,
}).annotate(
  Info,
  info({
    method: "create",
    note: "One period per department and semester, and the end is after the start (UK1). The state is never stored: it is Scheduled, Open or Closed by the dates.",
    replaces: ["RULE-103", "RULE-137"],
    resource: "AdmissionPeriod",
    summary: "Schedule an admission period for a department and a semester.",
  })
);

export const extendAdmissionPeriod = Rpc.make("extendAdmissionPeriod", {
  error: DomainErrorSchema,
  payload: { end: Schema.DateTimeUtcFromString, id: AdmissionPeriodId },
  success: StoredAdmissionPeriod,
}).annotate(
  Info,
  info({
    method: ":extend",
    note: "Moves the end later, never the start, and only while the period has not ended.",
    resource: "AdmissionPeriod",
    summary: "Extend an admission period.",
  })
);

export const deleteAdmissionPeriod = Rpc.make("deleteAdmissionPeriod", {
  error: DomainErrorSchema,
  payload: { id: AdmissionPeriodId },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    method: "delete",
    note: "Only a period that has not started and that no application refers to.",
    replaces: ["RULE-222"],
    resource: "AdmissionPeriod",
    summary: "Cancel an admission period.",
  })
);

export const submitApplication = Rpc.make("submitApplication", {
  error: DomainErrorSchema,
  payload: SubmitApplicationInput,
  success: ApplicationReceipt,
}).annotate(
  Info,
  info({
    machine: "Application",
    method: ":submit",
    note: "Anyone, with no account, while the department's period is Open. Turnstile and the rate limit have run before this transaction. It creates a person whose address is not verified, and queues the mail with the link that verifies it: the application is joined to a known person only after that (RULE-306).",
    replaces: ["RULE-105", "RULE-129", "RULE-138"],
    resource: "Application",
    summary: "Apply to become an assistant.",
  })
);

export const registerApplication = Rpc.make("registerApplication", {
  error: DomainErrorSchema,
  payload: RegisterApplicationInput,
  success: ApplicationReceipt,
}).annotate(
  Info,
  info({
    machine: "Application",
    method: ":register",
    note: "Recruitment staff, at a stand, in a period of the current semester; the period need not be open. The same input and the same checks as a public submit, and one application per address and period.",
    replaces: ["RULE-221", "UNMATCHED-153"],
    resource: "Application",
    summary: "Register an applicant on their behalf.",
  })
);

export const withdrawApplication = Rpc.make("withdrawApplication", {
  error: DomainErrorSchema,
  payload: { id: ApplicationId },
  success: Schema.Void,
}).annotate(
  Info,
  info({
    machine: "Application",
    method: ":withdraw",
    note: "The applicant, when signed in, or the department's recruitment staff and leaders. A withdrawn application is kept until its period's retention ends; nobody deletes one by hand.",
    replaces: ["RULE-283", "RULE-286"],
    resource: "Application",
    summary: "Withdraw an application.",
  })
);

export const AdmissionRpc = RpcGroup.make(
  createAdmissionPeriod,
  extendAdmissionPeriod,
  deleteAdmissionPeriod,
  submitApplication,
  registerApplication,
  withdrawApplication
);

/**
 * The stored machine of an application: created Submitted by a public submit or a registration, and Withdrawn from
 * there. Spec 0010 adds Accepted and NotAccepted, and spec 0011 Placed.
 */
export const ApplicationMachine = Machine.make({
  commands: AdmissionRpc,
  context: Schema.Struct({}),
  name: "Application",
  states: ApplicationState,
  terminal: ["Withdrawn"],
  transitions: [
    { command: "submitApplication", from: [Machine.Boundary], to: "Submitted" },
    {
      command: "registerApplication",
      from: [Machine.Boundary],
      to: "Submitted",
    },
    { command: "withdrawApplication", from: ["Submitted"], to: "Withdrawn" },
  ],
});

/** One transition of the Application machine: what a repository applies to a stored application. */
export type ApplicationMachineTransition =
  (typeof ApplicationMachine)["transitions"][number];

export const AdmissionDomain = declareDomain({
  commands: AdmissionRpc,
  grants: [
    grant(
      [leader, fn("recruitment")],
      [
        "createAdmissionPeriod",
        "extendAdmissionPeriod",
        "deleteAdmissionPeriod",
        "registerApplication",
        "withdrawApplication",
        "viewAdmission",
      ],
      "department"
    ),
    grant([self], ["withdrawApplication"], "own"),
    grant([anyone], ["submitApplication"], "all"),
  ],
  machines: [ApplicationMachine],
  name: "admission",
  reads: {
    viewAdmission: {
      replaces: ["RULE-287", "RULE-309"],
      summary:
        "See the department's admission periods and the applications to them.",
    },
  },
  title: "Admission",
});
