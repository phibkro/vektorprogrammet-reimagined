# Vektorprogrammet

Vektorprogrammet is a volunteer organisation. It sends university students into lower secondary schools as assistants in mathematics classes. This glossary gives one name to each concept, with its Norwegian word. The documents in `docs/system/` and the code use these names.

## Organisation

**Department** (avdeling): A local branch of Vektorprogrammet at one university, for example NTNU, NMBU or UiB. _Avoid_: region, branch, chapter

**Team** (team): A group of volunteers in one department with one task, for example recruitment or economy. _Avoid_: group, committee

**Board** (styret): The team that leads a department. The national board (hovedstyret) leads the whole organisation. _Avoid_: executive board, management

**Team function**: The kind of work a team does: board, economy, IT, recruitment, placement or other. The function decides what members of the team can do in the system. _Avoid_: role, team type

**Unit** (enhet): An organisational grouping of persons: Vektorprogrammet, a department, a team, the board, a school or a sponsor. Units form a tree with Vektorprogrammet as the root.

**Role kind** (rolletype): A role declared in code for a unit kind. Its privileges come from the grant table.

**Label** (etikett): Display text on a role assignment, such as “Nestleder” or “Kasserer”. A label never gives permission.

**Decision** (vedtak): A recorded decision by a unit. A passed decision authorises its command and is its audit record.

**Decision rule** (vedtaksregel): The declaration of who may propose, who may decide, how it passes, and what happens at its deadline.

**Link** (lenke): A single-use credential for a purpose. Any person status may present it; it is not a role.

**Renewal plan** (fornyelsesplan): The approved interval, latest end date and on/off setting for automatic extensions of a role assignment. The same unit decision or Admin grant approves the plan and assignment; its cap comes from the role-kind declaration.

**Semester** (semester): A half-year: spring (vår, January to July) or autumn (høst, August to December). Every workflow in the system belongs to one semester. _Avoid_: term (used for something else below)

## People

**Person**: One human known to Vektorprogrammet: an applicant, an assistant, a team member, or a former one. One person has one record, even when they leave and come back. _Avoid_: user, member, account (an account is how a person logs in)

**Engagement**: A period in which a person works for Vektorprogrammet: a placement or a current role assignment in an internal unit (Department or Team). A School or Sponsor contact assignment is not an engagement. _Avoid_: involvement, participation

**Assistant** (vektorassistent): A person with a placement in the current semester. _Avoid_: volunteer (too wide), helper

**Role assignment**: A person's place in one unit: a role kind held for a term, with an optional display label and renewal plan. A contact on an external unit is not membership in Vektorprogrammet. _Avoid_: role (when you mean role kind)

**Membership** (teammedlemskap): A person's role assignment in a team, with a role kind, a label and a term. _Avoid_: role (for the role kind), team assignment

**Term** (periode): The period a role assignment covers. A membership term runs from its start semester to its end semester. Every membership has an end semester. _Avoid_: tenure, duration

**Team leader** (teamleder): A person with the `leader` role kind in a team. _Avoid_: head, admin

**Admin**: A person with the `admin` role kind on the Vektorprogrammet unit. An admin can do every action available to a person, but not a system job. _Avoid_: superuser, administrator role

**Alumnus** (tidligere medlem): A person with no current engagement in an internal unit who agreed that Vektorprogrammet keeps their details for 5 years. _Avoid_: ex-member, inactive user

## Acting in the system

**Principal** (aktør): The accountable party that holds grants: `Anonymous`, a Person, a named system principal, a `Link(purpose)` holder, or `Emergency`. A person principal is an actor in business language and an ArchiMate Business Actor. _Avoid_: user, role, actor (in code)

**System principal**: A principal that is a part of Vektorprogrammet's own system, for example the semester job, the retention job or, for the posts it makes on its own account, the Slack bot (ADR 0013, 2026-10-30). It acts only through its own grants. In ArchiMate, an Application Process of an Application Component, not a Business Actor. _Avoid_: root, service account, bot (alone; see **Slack bot**)

**Credential** (innloggingsmiddel): What proves a principal: a password, a passkey, a single-use code, or the platform's trigger for a scheduled job. _Avoid_: login, auth

**Session** (økt): A period in which one credential holds one principal on one client. A person can see and end their sessions. _Avoid_: login, token

**Client** (klient): The software that acts on behalf of a principal: a browser on a desktop or a phone, the server that runs a request, the scheduler, the import tool, or the Slack bot when it relays a person's command. A client never has more permissions than its principal and never has grants of its own. In business language, an agent. _Avoid_: device, agent (in code), app

**Slack bot**: The organisation's Slack app. It has two roles that are never mixed (ADR 0013, revised 2026-10-30): a **client** of a person's principal when it relays that person's click or command, and a **system principal** of its own, `System(slackBot)` (a proposed name), for the scheduled and system posts that no person's command caused. A person's command never runs as the bot's principal. _Avoid_: Slack principal (for a person's click), Slack user (the person)

**Slack link**: An explicit, recorded link between one Person and one Slack user id. It records its source (`auto: verified e-mail` or `manual: Sign in with Slack`) and, for an automatic link, the matched address. The person can remove it on Min side. It is how a click of a human becomes that person's command; the bot's own principal needs none.

## Activities

**Activity**: An occasion that persons plan and the system schedules, runs and notifies: for example a social event, a general meeting or an election. It is not a domain or audit event (the facts that commands record). In ArchiMate, a Business Interaction. _Avoid_: event (for the occasion)

**Activity type**: A declaration in code that says which capabilities an Activity has (required, optional, absent, or required when an instance setting holds). The audience follows one rule for every type. _Avoid_: event type

**Capability**: An optional part of an Activity type: RSVP, Check-in or Voting.

**RSVP**: A person's answer to an Activity: yes, no or maybe.

**Check-in**: A record that a person is present at an Activity during its check-in window. It can count toward a quorum.

**Organiser**: A person named on an Activity who may manage it. Whether it should be a role kind is open in ADR 0013.

## Admission and recruitment

**Admission period** (opptaksperiode): The window in which a department accepts applications for one semester. _Avoid_: admission, application window, intake

**Application** (søknad): A request from a person to become an assistant in one admission period. _Avoid_: signup, registration

**Applicant** (søker): The person that an application belongs to. A public submit makes a new applicant whose e-mail address is not verified; the link in the mail verifies it. _Avoid_: candidate, user

**Verified address** (bekreftet e-postadresse): An address that its holder proved by spending the single-use code of the link in a mail (`person.email_verified`). Only a verified address is unique, and only after verification can an application be joined to a person the system already knows by it (RULE-306). _Avoid_: confirmed e-mail

**Admission alert** (opptaksvarsel): An e-mail to people who asked to be told when a department opens an admission period. _Avoid_: newsletter, interest list, subscription (in prose)

**Interview** (intervju): The conversation in which the recruitment team assesses an application, recorded as answers to an interview form. _Avoid_: screening, assessment

**Interview form** (intervjuskjema): The questions that interviewers answer for each applicant. A form is drafted, then published as a version that cannot change. _Avoid_: template, schema, questionnaire

**Score** (poengsum): The sum of the answers to the score questions of an interview form. It is always calculated from the answers. _Avoid_: rating, grade, points

**Outcome** (opptaksresultat): The decision on an application: accepted or not accepted. _Avoid_: result, verdict, status

## Placement

**School** (skole): A lower secondary school that receives assistants as a client of Vektorprogrammet. _Avoid_: product, partner

**School capacity** (skolekapasitet): How many assistants a school can take on each weekday in one semester. _Avoid_: slots, quota

**Placement** (plassering): An accepted applicant assigned to a school, weekday and block for one semester. _Avoid_: assignment, allocation, assistant history

**Placement suggestion** (forslag til plassering): A draft list of placements that the system calculates. Staff accept or change it. It is never saved by itself. _Avoid_: schedule, auto-placement

## Economy

**Expense claim** (utlegg): A request from a person to get back money that they spent for Vektorprogrammet, with a receipt attached. _Avoid_: receipt (the receipt is the attachment), reimbursement request

**Refund** (tilbakebetaling): The payment of an approved expense claim to the claimant's bank account. _Avoid_: payout, reimbursement

**Bookkeeping export** (regnskapseksport): The file of refunded expense claims for one department and one year, for the bookkeeping system. _Avoid_: report, integration

## Personal data

**Retention period** (lagringstid): How long the system keeps one kind of personal data before it deletes or anonymises it. _Avoid_: TTL, expiry

**Retention report** (lagringsrapport): The nightly retention run in its counting mode. It finds what has reached the end of its period, counts it and audits the counts (`retention.reported`), and changes nothing. Production runs it until every period that the run applies is approved; local and preview deployments, which hold fake data, run the retention for real. _Avoid_: dry run, simulation

**Consent** (samtykke): A recorded answer from a person to one question, for example "keep my details for 5 years" or "send me alumni news". The record names the version of the text that the person saw, when they said yes and when they withdrew. A "no" is a record too. A person can withdraw each consent separately. _Avoid_: opt-in, permission

**Declaration** (deklarasjon): What the code says, once, about each stored column: what it holds about a person and why (purpose, legal basis, retention, and what happens at the end), or why it holds nothing about a person. The retention job, the export, the erasure, the merge, the privacy notice and the record of processing are all read from it. _Avoid_: annotation, policy

**Privacy notice** (personvernerklæring): The text on a form that says what it collects, why, who gets it and how long it is kept. The system generates it from the declarations. _Avoid_: privacy policy, terms

**Record of processing** (behandlingsprotokoll): The list of every kind of personal data the organisation keeps, with its purpose, legal basis and retention (GDPR Art. 30). The system generates it from the declarations. _Avoid_: data register, inventory

**Anonymisation** (anonymisering): Replacing a person's name, addresses and other core fields with placeholders, so that the row names nobody. The row stays, and so does the history that refers to it. _Avoid_: masking, pseudonymisation

**Erasure** (sletting): Anonymising a person's core fields and deleting their account, sessions, consents and subscriptions, on request. History rows, such as memberships, stay and name nobody. _Avoid_: delete account, deactivation (a deactivated account keeps all data)

**Merge** (sammenslåing): Joining two records of one person. Every row of the second record moves to the first. _Avoid_: dedupe, link

**Tombstone** (tom post): The record that a merge leaves behind. It has no name or address and says which record remains. _Avoid_: deleted person, duplicate

**Legal hold** (oppbevaringsplikt): A reason in law that data must stay, for example an expense claim under accounting retention. Erasure reports it with its end date, or stops while it is open. _Avoid_: freeze, lock

**Alumni request** (alumniforespørsel): The one e-mail that asks a person who has left two questions about their data: may the organisation keep their details longer, and may it send alumni news. There is one for each person and each end of an engagement. _Avoid_: survey, newsletter signup

## Elections and voting

**Election** (valg): A democratic decision with candidates for seats, counted by a voting system. The electorate is frozen at the nomination cut-off.

**Election type** (valgtype): A declaration in code that sets the electorate rule, positions and role kinds granted by an election.

**Electorate** (velgermasse): The people eligible to vote in one election, determined by its scope and frozen at nomination cut-off.

**Voting system** (valgsystem): A typed composition of ballot type, aggregation, win condition, denominator and tie-break chain.

**Motion vote** (avstemning): A democratic decision on a proposal, using yes/no/abstain ballots and a declared threshold.

**Certification** (godkjenning): The passed decision that confirms an election result and is the recorded origin of elected role assignments. The election type declares the certifier subject set; `System(elections)` creates the role assignments at term start. When all certifiers are candidates, authority falls to the parent unit's committee and then Admin at the root.

**Ballot type** (stemmeseddeltype): The form of one ballot: yes/no/abstain, single choice, approval, ranked, or score/grade.

**Aggregation** (aggregering): The typed function that combines ballots into a result, such as counting, elimination rounds, or a pairwise matrix.

**Win condition** (vinnerregel): The condition that makes a candidate or motion win, applied to an aggregation result.

**Tie-break chain** (avgjørelseskjede): Zero or more non-deciding rules followed by one terminal rule that always decides. The election default is runoff, committee, then lot; aggregation-specific tie rules run first.

**Denominator** (nevner): The declared basis for a threshold: valid ballots, all ballots cast, checked-in attendees, or the whole electorate.

**Preset** (forhåndsvalg): A named voting-system composition with sensible defaults for its parameters. An election type restricts which presets may be selected.

## System structure

**Module**: A named group of files in one package. It has one layer and a declared list of the modules it may use. A module has no version of its own. _Avoid_: component, package (a package is a unit of versioning and install)

**Library**: A module with no runtime and no authority. It holds the constructs, patterns and shared words that services build on, and it imports only other libraries. _Avoid_: shared, common, utils

**Vocabulary**: The library of closed sets, identifiers, errors, calendar values and principal shapes that several services name. _Avoid_: shared kernel, common types

**Service**: A module that declares the commands, ports and rules of one part of the organisation's work, for example Membership, IAM or Audit. It uses libraries and the services it declares. _Avoid_: microservice (a service is not deployed on its own), bounded context

**Triggers**: The service that says when work starts: the scheduled jobs and the delivery of outbox messages. Each service declares its own jobs. _Avoid_: scheduler, queue

**Catalog**: A module that lists what every service contributes, for example the personal-data catalog or the job registry. It imports the services, and no service imports it. _Avoid_: index, shared list

**Assembly**: The top of the domain: the list of all declarations, the public surface and the catalogs that only documents and tests read. _Avoid_: barrel, root

**Platform**: What our code runs on and stores its records in: Workers, Neon/PostgreSQL through Hyperdrive, Queues and R2. It holds our records of truth and can take part in our transaction. It implements the ports of the services, and nothing in the domain imports it. _Avoid_: infrastructure, backend

**Integration**: Another system with its own state and rules that we adapt to, for example Google Workspace, Slack, the mail provider, Turnstile, EmDash's API or Better Auth. It is always outside our transaction: we reach it after commit, at least once, with an idempotent call. Four rules apply: no call inside a transaction, a declared non-production stand-in, declared personal data received, and provider secrets only in the background Worker (ADR 0015). _Avoid_: connector, plugin, adapter (an adapter implements a port on the platform)

**Data migration**: A program that moves data from the legacy system into the new one: it extracts the legacy MySQL database, transforms the legacy model into the new model, loads PostgreSQL and EmDash, and writes a reconciliation report. It is rerunnable until the production cutover and then retired. _Avoid_: import (when you mean the whole program), migration (alone)

**Schema migration**: A change to the shape of the database, one file in `packages/db/drizzle/`, applied with `db:migrate`. It moves no data from the legacy system. _Avoid_: migration (alone), data migration
