/**
 * Public surface of `@vektorprogrammet/domain`. See `README.md` (package) for
 * the contexts and services and `src/README.md` for the transaction convention.
 */

// shared
export * from "./shared/actor.ts";

export * from "./shared/capabilities.ts";

export * from "./shared/clock.ts";

export * from "./shared/errors.ts";

export * from "./shared/ids.ts";

export * from "./shared/outbox.ts";

export * from "./shared/transaction.ts";

export * from "./shared/validation.ts";

// audit (C12)
export * from "./audit/auditLog.ts";

// organisation (C1, C2)
export * from "./organisation/admission.ts";

export * from "./organisation/commands.ts";

export * from "./organisation/department.ts";

export * from "./organisation/fieldOfStudy.ts";

export * from "./organisation/semester.ts";

export * from "./organisation/services.ts";

// content (C3, C4, C5, C6, C8)
export * from "./content/article.ts";

export * from "./content/commands.ts";

export * from "./content/home.ts";

export * from "./content/sanitizer.ts";

export * from "./content/services.ts";

export * from "./content/slug.ts";

export * from "./content/socialEvent.ts";

export * from "./content/sponsor.ts";

export * from "./content/staticContent.ts";

// contact (C10)
export * from "./contact/commands.ts";

export * from "./contact/supportTicket.ts";

// files (C11)
export * from "./files/commands.ts";

export * from "./files/fileType.ts";

export * from "./files/publicFile.ts";

export * from "./files/services.ts";
