---
status: accepted
---

# Purpose, legal basis and retention are declared once per field

Each personal field declares its purpose, its GDPR legal basis and its retention period in `packages/domain`. The record of processing activities, the privacy notice and the nightly retention job are generated from this declaration. A test fails if a personal column has no declaration. The retention periods are in `docs/system/administration.md`. This decision supersedes the 2026-10-16 decision in the modernization brief to migrate all legacy data with the legacy retention.

Three documents and one job describe the same facts. If they are kept by hand, the privacy notice says one thing and the job does another. Datatilsynet's guidance for associations is to delete member data when a person leaves, unless the person agrees to something else. The legacy system kept everything.

## Considered options

- **A hand-written privacy notice and a separate deletion script.** Rejected: two copies of the same facts.
- **Migrate all legacy data.** Rejected: the 2024 backup holds bank account numbers, old applications and special-needs text with no current purpose.

## Consequences

- Migration takes current people and 10 years of engagement history only. The backup file is deleted after cutover.
- When a person leaves, the system asks for consent to keep their details for 5 years. Without it, it anonymises them after 1 year.
- Before go-live, every processor runs on an organisation-owned account with a data processing agreement.

Source: `../../../../analysis/vektorprogrammet/INFORMATION_MODEL.md` §11.
