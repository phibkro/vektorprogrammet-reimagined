# Commands by resource

Every command of the system names the **resource** it acts on and the **method** it uses (ADR 0010, `../decisions/0010-commands-carry-their-resource-method.md`, spec 0007c). This page lists them by resource, from every domain: to find what can be done to a membership, or to a person, look under that name, whichever domain declares the command.

The method is `get`, `list`, `create`, `update` or `delete`, or a custom verb written with a colon (`:extend`). A command's name follows its method: `createTeam`, `updatePerson`, `deleteAdminGrant`, and `extendMembership` for `:extend`. The ADR says when a standard method is the right one and when a custom verb is.

The page is generated from the declarations in `packages/domain`: run `bun run docs` after changing one. CI runs `bun run check:docs`. Who may run a command is in the domain's own page (`teams.md`, `accounts.md`) and in the grant table; the last column shows it here too.

## Commands

<!-- docgen:begin resources -->

### Department

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createDepartment` | `create` | organisation | Create a department. | Admin |
| `updateDepartment` | `update` | organisation | Change a department's details. | Leader(d); Admin |

### Semester

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `ensureSemesters` | `:ensure` | organisation | Keep the current and the next semester present. | System(semesters) |

### FieldOfStudy

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createFieldOfStudy` | `create` | organisation | Add a field of study to a department. | Leader(d); Admin |
| `updateFieldOfStudy` | `update` | organisation | Rename a field of study. | Leader(d); Admin |

### SocialEvent

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createSocialEvent` | `create` | content | Add a social event for a department and a semester. | Member(d); Admin |

### PublicFile

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createPublicFile` | `create` | files | Register an uploaded file so that it can be served. | Member(d); Admin |

### Person

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createPerson` | `create` | teams | Register a person, with the field of study that gives them a department. Granted for the department of the chosen field of study. | Leader(d) ∪ Board; Admin |
| `updatePerson` | `update` | accounts | Update a person's profile. | Leader(d); Self; Admin |
| `setPhoto` | `:set` | personalData | Set a person's photo under their consent, or remove it. A photo is stored only under a current photo consent; withdrawing the consent removes it. | Self; Leader(d); Admin |
| `verifyApplicantEmail` | `:verify` | personalData | Verify the address of an applicant with the code from the confirmation e-mail. One use. It answers the same whether the address was known or not; when a verified person holds the address, the new person is merged into that one (an anonymised tombstone stays), so an application is joined to a known person only after the address is verified (RULE-306, spec 0009). | Holder(verifyApplication) |
| `exportMyData` | `:export` | personalData | Download everything held about a person as JSON (GDPR Art. 15, 20). Audited. It changes no data. Only the person themself can download it: an administrator's grant does not reach this command, and the handler refuses it. | Self; Admin |
| `erasePerson` | `:erase` | personalData | Anonymise a person's core fields and delete their account, sessions, consents and subscriptions. The history rows stay (GDPR Art. 17). Refused, with the reason, while a legal hold applies and when it would remove the last Active admin. A second call changes nothing. | Self; Admin |
| `mergePersons` | `:merge` | personalData | Merge two records of one person: every row of the second follows the first, and the second becomes a tombstone without personal data. Refused with a typed conflict, and nothing changes, when both records have an account or when two memberships in one team would overlap. | Admin |

### Account

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createAccount` | `create` | accounts | Invite a person to activate an account. | Leader(d); Admin |
| `activateAccount` | `:activate` | accounts | Activate an invited account with its single-use code. | Holder(activation) |
| `requestPasswordReset` | `:requestPasswordReset` | accounts | Request a password reset without revealing whether an account exists. | Anyone; Admin |
| `resetPassword` | `:resetPassword` | accounts | Reset an active account's password with its single-use code. | Holder(resetPassword) |
| `deactivateAccount` | `:deactivate` | accounts | Deactivate an account without changing the person. Never one's own account and never the last active admin. | Admin |
| `reactivateAccount` | `:reactivate` | accounts | Reactivate a deactivated account. Never one's own account. | Admin |

### Team

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createTeam` | `create` | teams | Create a team in a department. | Leader(d) ∪ Board; Admin |
| `updateTeam` | `update` | teams | Change a team's name, function, default term and Workspace group address. | Leader(d) ∪ Board; Admin |
| `deactivateTeam` | `:deactivate` | teams | Deactivate a team. A team is never deleted. | Leader(d) ∪ Board; Admin |

### Membership

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createMembership` | `create` | teams | Add a person to a team for a term and queue welcome messages for their first membership. The end defaults to the team's default term. | Leader(d) ∪ Board; Admin |
| `deleteMembership` | `delete` | teams | Cancel a membership that has not started. | Leader(d) ∪ Board; Admin |
| `extendMembership` | `:extend` | teams | Extend a membership to a later end semester. | Leader(d) ∪ Board; Admin |
| `changeMembership` | `:change` | teams | Change the position, team or leader flag from a semester: the old membership ends and a new one starts. A move to a team in another department also needs the grant in the receiving department, in the same transaction. | Leader(d) ∪ Board; Admin |
| `endEarlyMembership` | `:endEarly` | teams | End a membership from a semester. A member can end their own. | Leader(d) ∪ Board; Self; Admin |
| `sendEndingSoon` | `:sendEndingSoon` | teams | Four weeks before the semester ends, e-mail each team leader the memberships of the department that end. | System(endingSoon) |

### AdminGrant

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createAdminGrant` | `create` | teams | Put a person on the admin list until a date. Never for oneself. | Admin |
| `deleteAdminGrant` | `delete` | teams | Take a place off the admin list. Never one's own, and never the last place that ends after the current semester and that an Active account holds. | Admin |

### Consent

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `setAlumniConsent` | `:set` | personalData | Answer the alumni questions on Min side: keep my details for 5 years, and send me alumni news. Only the person themself can answer: an administrator's grant does not reach this command, and the handler refuses it, because a consent is the person's own statement. | Self; Admin |
| `answerAlumniConsent` | `:answer` | personalData | Answer the alumni questions with the code from the e-mail. The code lives 60 days and can be used again, so an answer can be corrected; it never opens another command. | Holder(alumniConsent) |
| `sendAlumniConsent` | `:send` | personalData | When a person's last engagement ends, e-mail them the two alumni questions once. One request per person and engagement end. | System(alumniConsent) |

### Retention

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `runRetention` | `:run` | personalData | Each night, delete or anonymise what has reached the end of its declared period. The audit row holds integer counts per table, never a value. A production run only counts what it would change (audited as `retention.reported`) while any period that it applies is still a proposal; local and preview runs change it (`retention.ran`). | System(retention) |

### WorkspaceReport

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createWorkspaceReport` | `create` | workspace | Ask for a Google Workspace dry-run. Writes a request that the next tick takes; it calls no provider. The report appears when the run is done. | Admin |
| `syncWorkspace` | `:sync` | workspace | Compare the Google Workspace groups and accounts with the active memberships and record the changes. One chunk: records the accounts, or the next teams' groups, and the cursor. In write mode its last chunk queues the changes, unless the removals are over the cap. | System(workspaceSync) |

### AdmissionPeriod

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createAdmissionPeriod` | `create` | admission | Schedule an admission period for a department and a semester. One period per department and semester, and the end is after the start (UK1). The state is never stored: it is Scheduled, Open or Closed by the dates. | Leader(d) ∪ Fn(recruitment, d); Admin |
| `deleteAdmissionPeriod` | `delete` | admission | Cancel an admission period. Only a period that has not started and that no application refers to. | Leader(d) ∪ Fn(recruitment, d); Admin |
| `extendAdmissionPeriod` | `:extend` | admission | Extend an admission period. Moves the end later, never the start, and only while the period has not ended. | Leader(d) ∪ Fn(recruitment, d); Admin |

### Application

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `submitApplication` | `:submit` | admission | Apply to become an assistant. Anyone, with no account, while the department's period is Open. Turnstile and the rate limit have run before this transaction. It creates a person whose address is not verified, and queues the mail with the link that verifies it: the application is joined to a known person only after that (RULE-306). | Anyone; Admin |
| `registerApplication` | `:register` | admission | Register an applicant on their behalf. Recruitment staff, at a stand, in a period of the current semester; the period need not be open. The same input and the same checks as a public submit, and one application per address and period. | Leader(d) ∪ Fn(recruitment, d); Admin |
| `withdrawApplication` | `:withdraw` | admission | Withdraw an application. The applicant, when signed in, or the department's recruitment staff and leaders. A withdrawn application is kept until its period's retention ends; nobody deletes one by hand. | Leader(d) ∪ Fn(recruitment, d); Self; Admin |

### AuditEntry

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `listAuditEntries` | `list` | audit | Read the newest entries of the audit log. | Admin |

### Impact

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `listImpact` | `list` | impact | Read the evidence of operations: assistants placed, schools served and placements, by closed semester and department. The cells are released: a count below the minimum is suppressed, and a cell that no source answers is unavailable (spec 0027). | Admin |

### ImpactSnapshot

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `closeImpact` | `:close` | impact | Close the cells of every ended semester that a source answers, once: a closed cell never changes. | System(impactClose) |

### OutboxMessage

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `sweepOutbox` | `:sweep` | outbox | Find the pending outbox rows that no queue message covers any more. Names at most `limit` pending rows without a fresh receipt (older than `DeliveryPolicy.requeueAfter`) and no live claim: the job puts their ids on the queue again. It changes and delivers nothing: the queue's consumer delivers. | System(outboxSweep) |
| `deliverOutbox` | `:deliver` | outbox | Deliver the mail, Slack and credential intents that a queue message names. Claims the rows the queue message names, each only while it is pending and no live claim holds it; code mail is minted and acknowledged in its delivery transaction (spec 0007 R1). | System(outboxSweep) |
| `failOutbox` | `:fail` | outbox | Mark the rows that the queue gave up on as failed. The dead-letter queue's consumer: a row becomes `dead` only when it is pending, unclaimed and a delivery failure was recorded on it (`last_error`); a row that never failed stays pending for the sweep, and a delivered one is left alone. | System(outboxSweep) |
| `recordOutboxFailure` | `:record` | outbox | Record that a delivery could not start on the rows that the queue messages name. The consumer could not build its delivery stack (a sender or auth binding is missing or refused): it records the class of that failure on the rows its messages name, each only while pending and unclaimed, and dates the next attempt by `DeliveryPolicy.retryDelay` for the message's delivery count. The dead-letter queue's consumer can then end them. It reads and writes nothing else, and no provider was tried. | System(outboxSweep) |

### SupportTicket

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `submitContact` | `:submit` | contact | Send a message to a department's contact address. | Anyone; Admin |

<!-- docgen:end resources -->
