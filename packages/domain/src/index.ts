/**
 * Public surface of `@vektorprogrammet/domain`. See `README.md` (package) for
 * the contexts and services and `src/README.md` for the transaction convention.
 *
 * Each domain's declaration (its commands as `Rpc`s, its grants, its machines) is a namespace of its own
 * (`Teams.createTeam`, `Organisation.TeamsDomain`), because command names such as `extend` and `change` mean
 * nothing outside their domain.
 */

// kernel (spec 0006): principals, subject sets, grants, machines, commands, domain declarations
export * from "./kernel/authorize.ts";

export * from "./kernel/principal.ts";

export * as Commands from "./kernel/commands.ts";

export * as Domain from "./kernel/domain.ts";

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

// every domain's declaration, and the one grant table that `authorize` reads
export * from "./declarations.ts";

// shared
export * from "./shared/clock.ts";

export * from "./shared/errors.ts";

export * from "./shared/ids.ts";

export * from "./shared/outbox.ts";

export * from "./shared/siteOrigin.ts";

export * from "./shared/transaction.ts";

export * from "./shared/validation.ts";

// audit (C12)
export * from "./audit/auditLog.ts";

export * from "./audit/commands.ts";

export * as Audit from "./audit/declaration.ts";

// outbox sweep (the job `outboxSweep`; the handler is in apps/web)
export * as OutboxSweep from "./outbox/declaration.ts";

// organisation (C1, C2)
export * from "./organisation/admission.ts";

export * from "./organisation/commands.ts";

export * as Organisation from "./organisation/declaration.ts";

export * from "./organisation/department.ts";

export * from "./organisation/fieldOfStudy.ts";

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
