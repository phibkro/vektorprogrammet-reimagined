# Vektorprogrammet

Vektorprogrammet is a volunteer organisation. It sends university students into lower secondary schools as assistants in mathematics classes. This glossary gives one name to each concept, with its Norwegian name. The documents in `docs/system/` and the code use these names.

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

**Link** (lenke): A credential for a purpose that any person status can present. It is not a role.

**Semester** (semester): A half-year: spring (vår, January to July) or autumn (høst, August to December). Every workflow in the system belongs to one semester. _Avoid_: term (used for something else below)

## People

**Person**: One human known to Vektorprogrammet: an applicant, an assistant, a team member, or a former one. One person has one record, even when they leave and come back. _Avoid_: user, member, account (an account is how a person logs in)

**Principal**: A person, a system job, or an anonymous caller that acts in the system. The principal's facts determine which actions it can perform. _Avoid_: role, user

**Engagement**: A period in which a person does work for Vektorprogrammet. An engagement is a placement or a membership. _Avoid_: involvement, participation

**Assistant** (vektorassistent): A person with a placement in the current semester. _Avoid_: volunteer (too wide), helper

**Membership** (teammedlemskap): A person's role assignment in a team, with a role kind, a label and a term. _Avoid_: role (for the role kind), team assignment

**Term** (periode): The semesters a membership covers, from its start semester to its end semester. Every membership has an end semester. _Avoid_: tenure, duration

**Team leader** (teamleder): A person with the `leader` role kind in a team. _Avoid_: head, admin

**Admin**: A person with the `admin` role kind on the Vektorprogrammet unit. An admin can do every action available to a person, but not a system job. _Avoid_: superuser, administrator role

**Alumnus** (tidligere medlem): A person with no current engagement who agreed that Vektorprogrammet keeps their details for 5 years. _Avoid_: ex-member, inactive user

## Acting in the system

**Principal** (aktør): The party that is accountable for an action: a person, a named system job, or nobody (anonymous). Permissions are given to principals. _Avoid_: actor, user, role

**System principal**: A principal that is a job of Vektorprogrammet's own system, for example the semester job or the retention job. It acts only through its own grants. _Avoid_: root, service account, bot

**Credential** (innloggingsmiddel): What proves a principal: a password, a passkey, a single-use code, or the platform's trigger for a scheduled job. _Avoid_: login, auth

**Session** (økt): A period in which one credential holds one principal on one client. A person can see and end their sessions. _Avoid_: login, token

**Client** (klient): The software that acts on behalf of a principal: a browser on a desktop or a phone, the server that runs a request, the scheduler, or the import tool. A client never has more permissions than its principal. _Avoid_: device, agent, app

## Admission and recruitment

**Admission period** (opptaksperiode): The window in which a department accepts applications for one semester. _Avoid_: admission, application window, intake

**Application** (søknad): A request from a person to become an assistant in one admission period. _Avoid_: signup, registration

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

**Consent** (samtykke): A recorded yes from a person to one purpose, for example admission alerts. A person can withdraw each consent separately. _Avoid_: opt-in, permission
