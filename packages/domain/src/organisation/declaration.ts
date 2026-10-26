/**
 * The organisation domain as data (spec 0006, ADR 0006): its commands, who may run them, and the read that opens
 * the control panel. Phase 1's capabilities (`CreateDepartment`, `UpdateDepartment`, `ManageFieldsOfStudy`) are
 * these commands and rows; `commands.ts` holds their handlers.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Commands from "../kernel/commands.ts";
import * as Domain from "../kernel/domain.ts";
import * as Grant from "../kernel/grant.ts";
import * as Subject from "../kernel/subject.ts";
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
}).annotate(Commands.Info, Commands.info({ summary: "Create a department." }));

export const updateDepartment = Rpc.make("updateDepartment", {
  error: DomainErrorSchema,
  payload: UpdateDepartmentInput,
  success: Department,
}).annotate(
  Commands.Info,
  Commands.info({ summary: "Change a department's details." })
);

export const createFieldOfStudy = Rpc.make("createFieldOfStudy", {
  error: DomainErrorSchema,
  payload: FieldOfStudyInput,
  success: FieldOfStudy,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-139"],
    summary: "Add a field of study to a department.",
  })
);

export const renameFieldOfStudy = Rpc.make("renameFieldOfStudy", {
  error: DomainErrorSchema,
  payload: RenameFieldOfStudyInput,
  success: FieldOfStudy,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-139"],
    summary: "Rename a field of study.",
  })
);

export const ensureSemesters = Rpc.make("ensureSemesters", {
  error: DomainErrorSchema,
  success: Schema.Struct({ current: StoredSemester, next: StoredSemester }),
}).annotate(
  Commands.Info,
  Commands.info({
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

export const OrganisationDomain = Domain.make({
  commands: OrganisationRpc,
  grants: [
    Grant.make(
      [Subject.leader],
      ["updateDepartment", "createFieldOfStudy", "renameFieldOfStudy"],
      "department"
    ),
    Grant.make([Subject.member], ["openControlPanel"], "all"),
    Grant.make([Subject.system("semesters")], ["ensureSemesters"], "all"),
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
