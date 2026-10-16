/**
 * C1 departments (regions). City is unique (a database constraint in
 * `packages/db`; `create`/`update` fail with `AlreadyExists`).
 */
import { Schema } from "effect";

import { DepartmentId, FileKey } from "../shared/ids.ts";
import { SlackChannel } from "../shared/outbox.ts";
import {
  EmailAddress,
  EmailAddressInput,
  requiredText,
} from "../shared/validation.ts";

const NonBlank = Schema.String.check(Schema.isNonEmpty());

const departmentFields = {
  active: Schema.Boolean,
  address: Schema.NullOr(Schema.String),
  city: NonBlank,
  email: EmailAddress,
  latitude: Schema.NullOr(Schema.Finite),
  logoKey: Schema.NullOr(FileKey),
  longitude: Schema.NullOr(Schema.Finite),
  name: NonBlank,
  shortName: NonBlank,
  slackChannel: Schema.NullOr(SlackChannel),
};

export const Department = Schema.Struct({
  id: DepartmentId,
  ...departmentFields,
});

export type Department = typeof Department.Type;

/** A department without its id: what `create` and `update` write. */
export const DepartmentDraft = Schema.Struct(departmentFields);

export type DepartmentDraft = typeof DepartmentDraft.Type;

/** Form input for creating or updating a department. */
export const DepartmentInput = Schema.Struct({
  active: Schema.Boolean,
  address: Schema.NullOr(Schema.String),
  city: requiredText({ maxLength: 250 }),
  email: EmailAddressInput,
  latitude: Schema.NullOr(Schema.Finite),
  logoKey: Schema.NullOr(FileKey),
  longitude: Schema.NullOr(Schema.Finite),
  name: requiredText({ maxLength: 250 }),
  shortName: requiredText({ maxLength: 50 }),
  slackChannel: Schema.NullOr(SlackChannel),
});

export type DepartmentInput = typeof DepartmentInput.Type;
