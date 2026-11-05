import { JobTables } from "../../../domain/jobs/personalData.ts";
import { OutboxTables } from "../../../domain/outbox/personalData.ts";
/**
 * The catalog: every stored table's declaration, gathered from the domains that own them (spec 0007b). The tests close it
 * over the migrated schema, `derive.ts` reads it for the retention rules, the export, the erasure and the merge, and
 * `tools/docgen` renders the record of processing from it. Nothing else lists a table's columns by hand.
 */
import { AccountTables } from "../../accounts/domain/personalData.ts";
import {
  AdmissionTables,
  ApplicationForm,
} from "../../admission/domain/personalData.ts";
import { AuditTables } from "../../audit/domain/personalData.ts";
import { ContactForm } from "../../contact/domain/personalData.ts";
import { ContentTables } from "../../events/domain/personalData.ts";
import { FilesTables } from "../../files/domain/personalData.ts";
import { ImpactTables } from "../../impact/domain/personalData.ts";
import { OrganisationTables } from "../../organisation/domain/personalData.ts";
import { TeamsTables } from "../../teams/domain/personalData.ts";
import { WorkspaceTables } from "../../workspace/domain/personalData.ts";
import { ConsentTables } from "./consents.ts";
import type { TableDeclaration } from "./declaration.ts";
import type { FormDeclaration } from "./forms.ts";

/** The stored tables, by their SQL names. */
export const Catalog = {
  ...AccountTables,
  ...AdmissionTables,
  ...AuditTables,
  ...ConsentTables,
  ...ContentTables,
  ...FilesTables,
  ...ImpactTables,
  ...JobTables,
  ...OrganisationTables,
  ...OutboxTables,
  ...TeamsTables,
  ...WorkspaceTables,
} as const satisfies Readonly<Record<string, TableDeclaration>>;

/** Any catalog: the real one, or a smaller one that a test builds. */
export type CatalogOf = Readonly<Record<string, TableDeclaration>>;

/** Every form that collects personal data. Spec 0009b adds the alert forms. */
export const Forms: readonly FormDeclaration[] = [ApplicationForm, ContactForm];
