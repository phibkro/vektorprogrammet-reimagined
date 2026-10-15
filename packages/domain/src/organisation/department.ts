/**
 * C1 departments (regions). City is unique (a database constraint in
 * `packages/db`; `create`/`update` fail with `AlreadyExists`).
 */
import { Schema } from "effect";
import { DepartmentId, FileKey } from "../shared/ids.ts";
import { SlackChannel } from "../shared/outbox.ts";
import { EmailAddress, EmailAddressInput, requiredText } from "../shared/validation.ts";

const NonBlank = Schema.String.check(Schema.isNonEmpty());

const departmentFields = {
  name: NonBlank,
  shortName: NonBlank,
  email: EmailAddress,
  city: NonBlank,
  address: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  slackChannel: Schema.NullOr(SlackChannel),
  logoKey: Schema.NullOr(FileKey),
  latitude: Schema.NullOr(Schema.Finite),
  longitude: Schema.NullOr(Schema.Finite),
};

export const Department = Schema.Struct({ id: DepartmentId, ...departmentFields });
export type Department = typeof Department.Type;

/** A department without its id: what `create` and `update` write. */
export const DepartmentDraft = Schema.Struct(departmentFields);
export type DepartmentDraft = typeof DepartmentDraft.Type;

/** Form input for creating or updating a department. */
export const DepartmentInput = Schema.Struct({
  name: requiredText({ maxLength: 250 }),
  shortName: requiredText({ maxLength: 50 }),
  email: EmailAddressInput,
  city: requiredText({ maxLength: 250 }),
  address: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  slackChannel: Schema.NullOr(SlackChannel),
  logoKey: Schema.NullOr(FileKey),
  latitude: Schema.NullOr(Schema.Finite),
  longitude: Schema.NullOr(Schema.Finite),
});
export type DepartmentInput = typeof DepartmentInput.Type;
