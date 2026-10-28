/**
 * Public surface of `@vektorprogrammet/domain`. See `README.md` (package) for
 * the contexts and services and `src/README.md` for the transaction convention.
 *
 * Each domain's declaration (its commands as `Rpc`s, its grants, its machines) is a namespace of its own
 * (`Teams.createTeam`, `Organisation.OrganisationDomain`): a declaration exports many names (the commands, the group,
 * the machines, the domain) and each reads best beside its domain. A command's name is unique across domains on its
 * own (`Domain.allProblems` refuses a tag that two domains declare), so the namespace is for reading and not for
 * telling two commands of one name apart.
 */

// kernel (spec 0006): principals, subject sets, grants, machines, commands, domain declarations
export * from "./kernel/authorize.ts";

export * from "./kernel/principal.ts";

export * as Commands from "./kernel/commands.ts";

export * as Domain from "./kernel/domain.ts";

export * as Effx from "./kernel/effx.ts";

export * as Grant from "./kernel/grant.ts";

export * as Guard from "./kernel/guard.ts";

export * as Machine from "./kernel/machine.ts";

export * as Subject from "./kernel/subject.ts";

// Account credentials and their purpose policy (spec 0007)
export * from "./accounts/code.ts";

export * from "./accounts/entities.ts";

export * as Accounts from "./accounts/declaration.ts";

export * from "./accounts/sso.ts";

export * from "./accounts/services.ts";

export * from "./accounts/codeRepository.ts";

export * from "./accounts/passwordHasher.ts";

export * from "./accounts/commands.ts";

export * from "./accounts/principal.ts";

export * from "./accounts/sessionDirectory.ts";

export * from "./accounts/signInDirectory.ts";

// every domain's declaration, and the one grant table that `authorize` reads
export * from "./declarations.ts";

// the fake people of a local deployment, a Preview and the browser tests (fixture data, no engine)
export * from "./localPeople.ts";

// shared
export * from "./shared/aggregate.ts";

export * from "./shared/clock.ts";

export * from "./shared/errors.ts";

export * from "./shared/guarantees.ts";

export * from "./shared/ids.ts";

export * from "./shared/isolationProbe.ts";

export * from "./shared/outbox.ts";

export * from "./shared/siteOrigin.ts";

export * from "./shared/transaction.ts";

export * from "./shared/transactionModes.ts";

export * from "./shared/transactor.ts";

export * from "./shared/validation.ts";

// audit (C12)
export * from "./audit/auditLog.ts";

export * from "./audit/commands.ts";

export * as Audit from "./audit/declaration.ts";

// outbox delivery (the job `outboxSweep`; the handlers are in apps/web) and what an administrator reads of it
export * as OutboxSweep from "./outbox/declaration.ts";

export * from "./outbox/captured.ts";

export * from "./outbox/delivery.ts";

export * from "./outbox/status.ts";

// scheduled jobs (spec 0008): the declarations, the due rules, the record of runs and the completeness check
export * as Job from "./jobs/job.ts";

export * as JobRegistry from "./jobs/registry.ts";

export * as JobRun from "./jobs/runs.ts";

export { jobProblems } from "./jobs/problems.ts";

// Google Workspace projection (spec 0008): the company address rule, the pure plan, the ports and the handlers
export * from "./workspace/change.ts";

export * from "./workspace/commands.ts";

export * from "./workspace/companyEmail.ts";

export * as WorkspacePlan from "./workspace/plan.ts";

export * as Workspace from "./workspace/declaration.ts";

export * from "./workspace/report.ts";

export * from "./workspace/services.ts";

// organisation (C1, C2)
export * from "./organisation/admission.ts";

export * from "./organisation/commands.ts";

export * as Organisation from "./organisation/declaration.ts";

export * from "./organisation/department.ts";

export * from "./organisation/fieldOfStudy.ts";

export * from "./organisation/legacyImport.ts";

// The package root exports the answers to the calendar questions, not the window arithmetic they are
// built from (`semesterForDate`, `semesterWindow`, `windowContains`): outside the domain nobody can
// assemble a second "current semester" or "admission is open" rule. `test/organisation/oneDefinition.test.ts`
// pins this surface.
export {
  Semester,
  SemesterOrder,
  SemesterYear,
  StoredSemester,
  Term,
  isBetween,
  nextSemester,
  semesterLabel,
  sortNewestFirst,
  termLabel,
} from "./organisation/semester.ts";

export type { Window } from "./organisation/semester.ts";

export * from "./organisation/services.ts";

// content (C5 news rules, C6 sponsor order, C8)
export * from "./content/article.ts";

export * from "./content/commands.ts";

export * as Content from "./content/declaration.ts";

export * from "./content/sanitizer.ts";

export * from "./content/services.ts";

export * from "./content/slug.ts";

export * from "./content/socialEvent.ts";

export * from "./content/sponsor.ts";

// contact (C10)
export * from "./contact/commands.ts";

export * as Contact from "./contact/declaration.ts";

export { ContactForm } from "./contact/personalData.ts";

export * from "./contact/supportTicket.ts";

// files (C11)
export * from "./files/commands.ts";

export * as Files from "./files/declaration.ts";

export * from "./files/fileType.ts";

export * from "./files/publicFile.ts";

export * from "./files/services.ts";

// teams and people (spec 0006)
export * from "./teams/commands.ts";

export * as Teams from "./teams/declaration.ts";

export * from "./teams/endingSoon.ts";

export * from "./teams/entities.ts";

export * from "./teams/principalFacts.ts";

export * from "./teams/refusals.ts";

export * from "./teams/services.ts";

export * from "./teams/term.ts";

// personal data (spec 0007b): the declarations, their derivations, consent, and the commands that use them
export * as PersonalDataDeclaration from "./personalData/declaration.ts";

export { ConsentKind } from "./personalData/declaration.ts";

export * as PersonalDataRpcs from "./personalData/rpc.ts";

export * from "./personalData/alumni.ts";

export * from "./personalData/catalog.ts";

export * from "./personalData/commands.ts";

export * from "./personalData/consents.ts";

export * from "./personalData/derive.ts";

export * from "./personalData/duration.ts";

export * from "./personalData/forms.ts";

export * from "./personalData/notice.ts";

export * from "./personalData/periods.ts";

// Named, not `export *`: `semesterEnd` is window arithmetic, which the root keeps inside the domain (`oneDefinition.test.ts`).
export {
  afterDuration,
  dueWallRanges,
  fiscalYearDueBefore,
  inWallRanges,
  lastActivityDue,
  lastActivityEnd,
  retentionEnd,
  semesterDueYears,
  startIsDue,
} from "./personalData/retentionEnd.ts";

export type { ActivityFacts, WallRange } from "./personalData/retentionEnd.ts";

export * from "./personalData/services.ts";

export * from "./personalData/texts.ts";
