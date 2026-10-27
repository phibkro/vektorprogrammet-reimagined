import { createServerFn } from "@tanstack/react-start";
/**
 * Server functions for `/kontrollpanel`. Every write is a domain command run through `runCommand` (one
 * transaction: authorize, validate, write, audit), called through its endpoint: the input is decoded with the
 * command's own payload schema. Commands answer with a short notice; pages re-load their data afterwards.
 */
import { Effect, Schema } from "effect";

import { decodeDeployment } from "../server/deployment";
import {
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  saveSocialEventProgram,
} from "../server/panel";
import { panelReads } from "../server/panelReads";
import { runCommand, runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";
import { shellView } from "../server/shell";
import {
  addMemberProgram,
  cancelProgram,
  changeProgram,
  deactivateTeamProgram,
  endProgram,
  extendProgram,
  grantAdminProgram,
  registerPersonProgram,
  revokeAdminProgram,
  saveTeamProgram,
} from "../server/teams";

const formData = Schema.toStandardSchemaV1(Schema.FormData);

const TeamInput = Schema.toStandardSchemaV1(
  Schema.Struct({ id: Schema.Finite })
);

// ---------------------------------------------------------------- views

/** The layout's data: who is acting and the sidebar they get (`server/shell.ts`). */
export const getShell = createServerFn({ method: "GET" }).handler(
  ({ context }) => {
    const scope = requestScope(context);

    return runQuery(
      scope,
      Effect.flatMap(decodeDeployment(scope.env.DEPLOYMENT), shellView)
    );
  }
);

export const getDashboard = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getDashboard)
);

export const getDepartments = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getDepartments)
);

export const getSemesters = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getSemesters)
);

export const getFieldsOfStudy = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getFieldsOfStudy)
);

export const getSocialEvents = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getSocialEvents)
);

export const getTeams = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getTeams)
);

export const getTeam = createServerFn({ method: "GET" })
  .validator(TeamInput)
  .handler(({ context, data }) =>
    runQuery(requestScope(context), panelReads.getTeam(data.id))
  );

export const getPeople = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getPeople)
);

export const getAdmins = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), panelReads.getAdmins)
);

// ---------------------------------------------------------------- C1

export const saveDepartment = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveDepartmentProgram(data))
  );

export const saveFieldOfStudy = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveFieldOfStudyProgram(data))
  );

// ---------------------------------------------------------------- C8

export const saveSocialEvent = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveSocialEventProgram(data))
  );

// ---------------------------------------------------------------- teams, people and the admin list (spec 0006)

export const saveTeam = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), saveTeamProgram(data))
  );

export const deactivateTeam = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), deactivateTeamProgram(data))
  );

export const registerPerson = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), registerPersonProgram(data))
  );

export const addMember = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), addMemberProgram(data))
  );

export const extendMembership = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), extendProgram(data))
  );

export const changeMembership = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), changeProgram(data))
  );

export const endMembership = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), endProgram(data))
  );

export const cancelMembership = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), cancelProgram(data))
  );

export const grantAdmin = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), grantAdminProgram(data))
  );

export const revokeAdmin = createServerFn({ method: "POST" })
  .validator(formData)
  .handler(({ context, data }) =>
    runCommand(requestScope(context), revokeAdminProgram(data))
  );
