/**
 * Every domain's declaration in one list, and the grant table that `authorize` reads: the rows of all of them. The
 * control panel's sidebar and controls (`apps/web`), the completeness tests and the doc generator read this list,
 * so a domain that is not here has no permissions and no page.
 */
import { Array as Arr } from "effect";

import { AccountDomain } from "../features/accounts/domain/declaration.ts";
import { AdmissionDomain } from "../features/admission/domain/declaration.ts";
import { AuditDomain } from "../features/audit/domain/declaration.ts";
import { ContactDomain } from "../features/contact/domain/declaration.ts";
import { ContentDomain } from "../features/events/domain/declaration.ts";
import { FilesDomain } from "../features/files/domain/declaration.ts";
import { ImpactDomain } from "../features/impact/domain/declaration.ts";
import { OrganisationDomain } from "../features/organisation/domain/declaration.ts";
import { PersonalDataDomain } from "../features/personal-data/domain/rpc.ts";
import { TeamsDomain } from "../features/teams/domain/declaration.ts";
import { WorkspaceDomain } from "../features/workspace/domain/declaration.ts";
import { authorizeWith, canAnywhereWith } from "./kernel/authorize.ts";
import type { NamesOf } from "./kernel/domain.ts";
import * as Grant from "./kernel/grant.ts";
import * as Subject from "./kernel/subject.ts";
import { OutboxDomain } from "./outbox/declaration.ts";

/** The domains, in the order the docs list them. */
export const Declarations = [
  OrganisationDomain,
  TeamsDomain,
  AccountDomain,
  ContentDomain,
  FilesDomain,
  ContactDomain,
  AuditDomain,
  OutboxDomain,
  PersonalDataDomain,
  WorkspaceDomain,
  ImpactDomain,
  AdmissionDomain,
] as const;

/** Every command and read that any domain declares. */
export type Command = NamesOf<(typeof Declarations)[number]>;

/** What a person may run or open, across every domain: the one Admin row names all of it. */
const personal = Arr.flatMap(
  Declarations,
  (domain): readonly Command[] => domain.personal
);

/**
 * The permission table: the rows each domain declared, and one `Admin` row for everything a person may run (ADR
 * 0001: `Admin` holds every command with `all` as one row). The jobs' commands are in no one's row but their own.
 */
export const GrantTable: readonly Grant.Row<Command>[] = [
  ...Arr.flatMap(
    Declarations,
    (domain): readonly Grant.Row<Command>[] => domain.declared
  ),
  ...(Arr.isReadonlyArrayNonEmpty(personal)
    ? [Grant.make([Subject.admin], personal, "all")]
    : []),
];

/** Whether a principal may run a command about a resource, by the whole table. */
export const authorize = authorizeWith<Command>(GrantTable);

/** Whether a principal may run a command for at least one department, or for everything. */
export const canAnywhere = canAnywhereWith<Command>(GrantTable);
