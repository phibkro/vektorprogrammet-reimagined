/**
 * The organisation domain as data (spec 0006, ADR 0006): its commands, who may run them, and the read that opens
 * the control panel. Phase 1's capabilities (`CreateDepartment`, `UpdateDepartment`, `ManageFieldsOfStudy`) are
 * these commands and rows; `commands.ts` holds their handlers.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Info,
  grant,
  info,
  leader,
  member,
  system,
  make as declareDomain,
} from "../kernel/domain.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { DepartmentId, FieldOfStudyId } from "../shared/ids.ts";
import { Department, DepartmentInput } from "./department.ts";
import {
  FieldOfStudy,
  FieldOfStudyInput,
  FieldOfStudyRename,
} from "./fieldOfStudy.ts";
import { StoredSemester } from "./semester.ts";

export const UpdateDepartmentInput = Schema.Struct({
  id: DepartmentId,
  ...DepartmentInput.fields,
});

export const RenameFieldOfStudyInput = Schema.Struct({
  id: FieldOfStudyId,
  ...FieldOfStudyRename.fields,
});

export const createDepartment = Rpc.make("createDepartment", {
  error: DomainErrorSchema,
  payload: DepartmentInput,
  success: Department,
}).annotate(Info, info({ summary: "Create a department." }));

export const updateDepartment = Rpc.make("updateDepartment", {
  error: DomainErrorSchema,
  payload: UpdateDepartmentInput,
  success: Department,
}).annotate(Info, info({ summary: "Change a department's details." }));

export const createFieldOfStudy = Rpc.make("createFieldOfStudy", {
  error: DomainErrorSchema,
  payload: FieldOfStudyInput,
  success: FieldOfStudy,
}).annotate(
  Info,
  info({
    replaces: ["RULE-139"],
    summary: "Add a field of study to a department.",
  })
);

export const renameFieldOfStudy = Rpc.make("renameFieldOfStudy", {
  error: DomainErrorSchema,
  payload: RenameFieldOfStudyInput,
  success: FieldOfStudy,
}).annotate(
  Info,
  info({
    replaces: ["RULE-139"],
    summary: "Rename a field of study.",
  })
);

export const ensureSemesters = Rpc.make("ensureSemesters", {
  error: DomainErrorSchema,
  success: Schema.Struct({ current: StoredSemester, next: StoredSemester }),
}).annotate(
  Info,
  info({
    job: "semesters",
    replaces: ["RULE-237"],
    summary: "Keep the current and the next semester present.",
  })
);

export const OrganisationRpc = RpcGroup.make(
  createDepartment,
  updateDepartment,
  createFieldOfStudy,
  renameFieldOfStudy,
  ensureSemesters
);

export const OrganisationDomain = declareDomain({
  commands: OrganisationRpc,
  grants: [
    grant(
      [leader],
      ["updateDepartment", "createFieldOfStudy", "renameFieldOfStudy"],
      "department"
    ),
    grant([member], ["openControlPanel"], "all"),
    grant([system("semesters")], ["ensureSemesters"], "all"),
  ],
  name: "organisation",
  reads: {
    openControlPanel: {
      replaces: [],
      summary:
        "Open the control panel: the overview and the list of semesters.",
    },
  },
  title: "Organisation",
});
