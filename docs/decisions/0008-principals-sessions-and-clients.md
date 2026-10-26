---
status: proposed
---

# A person, a principal, a session and a client are four separate things

A **person** is a domain party (`docs/system/teams.md`). A **principal** is who is accountable for an action: `Anonymous`, a `Person`, or a `System` job such as the semester job. A **credential** proves a principal (password, passkey, single-use code, the platform's cron trigger). A **session** binds a principal to one **client** (a browser on a desktop or a phone, the import tool) for a time. Every action is recorded as "principal P, through client C in session S". Grants are given to principals only. A client or a session can narrow what its principal may do (for example a single-use invitation code allows only `activate`), but it never widens it.

The legacy system mixed these: a user row held the login, the roles and the person's data, and its scheduled jobs and console commands ran with no identity. Jobs that write without a principal cannot be authorized, audited or simulated. A person who uses two phones and a laptop needs to see and end each session without losing their record.

## Consequences

- Spec 0006 names the acting party `CurrentPrincipal` (`Anonymous | Person | System`). The scheduled jobs act through `authorize` with their own grants, and the audit log records the principal.
- Spec 0007 adds credentials and sessions with sign-in: each session records its client (user agent, created, last seen). A person sees their sessions and ends any of them. Ending a session never touches the person's data.
- Holders of single-use codes (activation, password reset, unsubscribe) are principals scoped to one command on one resource.
- The same model lets a simulation drive the system: a simulated client acts for a simulated principal through the same commands and grants as a browser does.

Source: operator input, 2026-10-26.
