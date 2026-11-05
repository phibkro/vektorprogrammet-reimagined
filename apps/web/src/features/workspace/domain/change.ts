/**
 * What the projection asks the directory to make true (spec 0008). Each change is a statement of state, not a step:
 * "this member is in this group", "this account exists". A provider that is told one twice finds it already true, so
 * the outbox's at-least-once delivery cannot double an effect.
 */
import { Schema } from "effect";

import { CompanyEmail } from "./companyEmail.ts";

export const WorkspaceChange = Schema.TaggedUnion({
  EnsureAbsent: { group: CompanyEmail, member: CompanyEmail },
  EnsureAccount: { address: CompanyEmail, name: Schema.NonEmptyString },
  EnsureGroup: { address: CompanyEmail, name: Schema.NonEmptyString },
  EnsureMember: { group: CompanyEmail, member: CompanyEmail },
});

export type WorkspaceChange = typeof WorkspaceChange.Type;
