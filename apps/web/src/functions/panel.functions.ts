import { createServerFn } from "@tanstack/react-start";
/**
 * Server functions for `/kontrollpanel`. Every write is a domain command run
 * through `runCommand` (one transaction: authorize, validate, write, audit).
 * Commands answer with a short notice; pages re-load their data afterwards.
 */
import { createSocialEvent } from "@vektorprogrammet/domain";
import { Effect, Schema } from "effect";

import { decodeDeployment } from "../server/deployment";
import {
  SAVED,
  dashboardView,
  departmentsView,
  fieldsOfStudyView,
  saveDepartmentProgram,
  saveFieldOfStudyProgram,
  semestersView,
  socialEventInput,
  socialEventsView,
} from "../server/panel";
import { runCommand, runQuery } from "../server/runtime";
import { requestScope } from "../server/scope";
import { shellView } from "../server/shell";

const formData = Schema.toStandardSchemaV1(Schema.FormData);

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
  ({ context }) => runQuery(requestScope(context), dashboardView)
);

export const getDepartments = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), departmentsView)
);

export const getSemesters = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), semestersView)
);

export const getFieldsOfStudy = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), fieldsOfStudyView)
);

export const getSocialEvents = createServerFn({ method: "GET" }).handler(
  ({ context }) => runQuery(requestScope(context), socialEventsView)
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
    runCommand(
      requestScope(context),
      Effect.as(createSocialEvent(socialEventInput(data)), SAVED)
    )
  );
