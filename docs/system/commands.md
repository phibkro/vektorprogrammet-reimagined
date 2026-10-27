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

### AuditEntry

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `listAuditEntries` | `list` | audit | Read the newest entries of the audit log. | Admin |

### OutboxMessage

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `sweepOutbox` | `:sweep` | outbox | Deliver due mail, Slack and credential intents. Claims at most `limit` due rows, or only `ids`; code mail is minted and acknowledged in its delivery transaction (spec 0007 R1). | System(outboxSweep) |

### SupportTicket

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `submitContact` | `:submit` | contact | Send a message to a department's contact address. | Anyone; Admin |

### WorkspaceReport

| Command | Method | Domain | What it does | Granted to |
| --- | --- | --- | --- | --- |
| `createWorkspaceReport` | `create` | workspace | Ask for a Google Workspace dry-run. Writes a request that the next tick takes; it calls no provider. The report appears when the run is done. | Admin |
| `syncWorkspace` | `:sync` | workspace | Compare the Google Workspace groups and accounts with the active memberships and record the changes. One chunk: records the accounts, or the next teams' groups, and the cursor. In write mode its last chunk queues the changes, unless the removals are over the cap. | System(workspaceSync) |

<!-- docgen:end resources -->
