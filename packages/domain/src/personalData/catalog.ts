/**
 * The catalog: every stored table's declaration, gathered from the domains that own them (spec 0007b). The tests close it
 * over the migrated schema, `derive.ts` reads it for the retention rules, the export, the erasure and the merge, and
 * `tools/docgen` renders the record of processing from it. Nothing else lists a table's columns by hand.
 */
import { AccountTables } from "../accounts/personalData.ts";
import { AuditTables } from "../audit/personalData.ts";
import { ContactForm } from "../contact/personalData.ts";
import { ContentTables } from "../content/personalData.ts";
import { FilesTables } from "../files/personalData.ts";
import { OrganisationTables } from "../organisation/personalData.ts";
import { OutboxTables } from "../outbox/personalData.ts";
import { TeamsTables } from "../teams/personalData.ts";
import { ConsentTables } from "./consents.ts";
import type { TableDeclaration } from "./declaration.ts";
import type { FormDeclaration } from "./forms.ts";

/** The stored tables, by their SQL names. */
export const Catalog = {
  ...AccountTables,
  ...AuditTables,
  ...ConsentTables,
  ...ContentTables,
  ...FilesTables,
  ...OrganisationTables,
  ...OutboxTables,
  ...TeamsTables,
} as const satisfies Readonly<Record<string, TableDeclaration>>;

export type TableName = keyof typeof Catalog;

/** Any catalog: the real one, or a smaller one that a test builds. */
export type CatalogOf = Readonly<Record<string, TableDeclaration>>;

/** Every form that collects personal data. Spec 0009 adds the application and alert forms. */
export const Forms: readonly FormDeclaration[] = [ContactForm];
