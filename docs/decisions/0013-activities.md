---
status: proposed
---

# Activities: planned occasions with RSVP, check-in and voting, and Slack as a client

An **Activity** is something that persons plan, that the system runs on a schedule, and that notifies its participants: a social event, a general meeting, an election, an onboarding day. An **Activity type** is declared in code. Each type switches on optional **capabilities**: **RSVP** (answers, capacity, waitlist, deadline), **Check-in** (attendance during a window, which gives a quorum) and **Voting** (ballots and a voting system, ADR 0012). The **audience** of an Activity is the persons of the internal units under the Activity's unit.

An Activity is not an event in the sense of the facts that a command records (audit rows, outbox messages). A command records those as it runs. An Activity is a thing in the calendar that people attend. This ADR avoids the word "event" for it.

**Principal** (aktør) is the accountable party that holds grants: a Person or a named system principal. **Client** is the software that acts on behalf of a principal (ADR 0008). In business language an actor is a principal (ArchiMate Business Actor) and an agent is a client; the words are not synonyms in this system. The information system is a set of named system principals, not one principal.

Slack is where the teams already talk. Social events today are arranged by hand with Slack messages (operator input, 2026-10-27). The Slack bot is a **client**, never a principal and never a holder of grants. A person clicking RSVP or voting acts as that Person through the Slack client. The system sending invitations, reminders or ballots acts as `System(activities)` through the Slack client, with its own least-privilege grants.

The accepted design (ADR 0005) does not rebuild social events: they move to Google Forms and Google Calendar. This ADR proposes to bring them back, as a supporting business process, in the form of one Activity type. Surveys, team applications and certificate requests stay out. The Activity frame also gives ADR 0012's elections their schedule, audience, check-in and notices.

## Activity, type and capabilities

The three levels are the same as in ADR 0012: a kind is a construct in code, a type is a declaration in code, and an instance is data.

| Level | Activity | Capability |
| --- | --- | --- |
| Kind | Activity | RSVP, Check-in, Voting |
| Type | Social event, General meeting, Election, Onboarding day | Each type says if a capability is `required`, `optional` or `absent` |
| Instance | The Trondheim summer party, 2027 | The settings of each capability on that instance |

An Activity has a unit, a title, a description, a place, a start and an end, one or more organisers, and a state. The semester follows from the start date.

| Type | RSVP | Check-in | Voting | Who may plan it (proposed) |
| --- | --- | --- | --- | --- |
| Social event | required | absent | absent | A person in the audience of the unit; an Admin |
| General meeting | optional | required | optional (motion vote) | The leader of the unit; an Admin |
| Election | optional | required in meeting mode | required (ADR 0012) | As ADR 0012 says: the leader of the unit; an Admin |
| Onboarding day, course | optional | optional | absent | The leader of the unit; an Admin |

The last two rows are examples. Their audience is open (see Open questions).

**Presets and composition.** A type is a **preset** (porcelain): choosing "Social event" switches on RSVP and nothing else, and every setting has a default. **Composition** (plumbing) is for advanced use: a person may switch an `optional` capability on or off, and set each setting, within the bounds that the type declares. Composition never goes beyond the type: a capability that the type marks `absent` cannot be added to an instance. Adding a type, or a capability to a type, is a change in code. Privileges are static (ADR 0001, ADR 0011), and a capability can carry authority: an election grants roles.

### The capabilities

- **RSVP.** A person in the audience answers `yes`, `no` or `maybe`. The instance may set a **capacity** (a number of places that `yes` can use), a **waitlist** (only with a capacity) and a **deadline**. A `maybe` does not take a place. A person has one answer per Activity and can change it until the deadline. There is no free-text field: allergies and other health data are special category data (GDPR Art. 9), and the system does not ask for them.
- **Check-in.** A person in the audience records that they are present, once, inside a **window** (a start and an end that the instance sets). The number of check-ins is the attendance. ADR 0012 uses it as the quorum for a meeting and as one choice of denominator. The window is a stored pair of dates; nothing keeps a timer.
- **Voting.** The ballots, the voting system and the count are ADR 0012's. An election is an Activity of the type Election, with Voting required. This ADR does not define elections.

An organiser may also check in a person who cannot (for example, a person without a phone). The audit entry names the organiser.

### Presence

Check-in has one setting, **presence**: `declared` or `scanned`. With `declared`, the check-in command is enough, so a person can check in from a Slack button at home. With `scanned`, the person must open the **check-in link** in the meeting window. The link is a QR code that the organiser shows on a screen in the room. This answers part of question 12 in ADR 0012 (how the system knows that a person is in the room). The check-in link is not a `Link(purpose)` credential (ADR 0011): it is the same for everyone in the room, and it does not name a person. It is a token for one Activity's check-in command, valid only in the window. The person must still be known: a signed-in person on Min side, or a person that the Slack link names. The token narrows what the person's own principal may do, and it never widens it (ADR 0008). Whether the code on the screen must rotate is open.

## Audience

One rule gives the audience of every Activity, and it is the rule of ADR 0012 for electorates:

> The audience is every person with a current role assignment of kind `member` or `leader` in an internal unit (Department or Team) in the subtree of the Activity's unit.

- **Example.** A social event of the Trondheim department goes to every person in a team of Trondheim. An Activity of the national board's unit (a team directly under the root) goes to the members of the whole subtree of the root, that is, everyone.
- A person counts once, however many teams they are in.
- **Never external units.** The contacts of a School or a Sponsor are not members of Vektorprogrammet (ADR 0011). They are never in an audience.
- **Assistants only if the type says so.** An assistant has a placement, not a team membership. No type in the table above includes assistants. Whether some types should is an open question.
- **The audience is computed, not stored.** The system reads the role assignments when it runs a command or sends a notice. A person who joins a team later can answer. A person who leaves can no longer answer. The Voting capability is the exception: it freezes its own electorate at the cut-off (ADR 0012).

The kernel gets two subject sets, in the style of ADR 0011's `TeamMember(t)`. The Activity comes from the command's resource.

| Subject set | Meaning |
| --- | --- |
| `Audience(a)` | The principal is a person in the audience of Activity `a` |
| `Organiser(a)` | The principal is a person that the Activity names as an organiser |

## Lifecycle and commands

An Activity is a machine with a transition table (ADR 0007). Whether it has happened is derived from its end date, as in the legacy badges (RULE-085). Whether RSVP is open, and whether the check-in window is open, are derived from stored dates. Only a change that someone decides is a state.

| From | Command | To | Notes |
| --- | --- | --- | --- |
| `[*]` | `createActivity` | Planned | The creator is the first organiser. Not visible to the audience. |
| Planned | `announceActivity` | Announced | Writes one notice per person in the audience to the outbox (see Messages). |
| Planned, Announced | `cancelActivity` | Cancelled | Notifies those who answered `yes` or `maybe`. A cancelled Activity never reopens. |

| Command | Resource and method (ADR 0010) | Granted to |
| --- | --- | --- |
| `createActivity` | `Activity`, `create` | The type's planners (table above); `Admin` |
| `updateActivity`, `announceActivity`, `cancelActivity` | `Activity`, `update` and custom | `Organiser(a)`; `TeamLeader(u)` of the Activity's unit `u`; `Admin` |
| `setRsvp` | `Rsvp`, `set` | `Audience(a)`, own answer only |
| `createCheckIn` | `CheckIn`, `create` | `Audience(a)`, own check-in; `Organiser(a)` for another person |
| `createSlackLink`, `deleteSlackLink` | `SlackLink`, `create` and `delete` | `Self` |
| Reminders and waitlist steps | jobs | `System(activities)`, its own grants (ADR 0008) |

The spec that builds this fixes the final names. A change to an Announced Activity (time, place, capacity) notifies the persons who answered `yes` or `maybe`.

**Races by construction.** The capacity check and the write of a `yes` are one conditional write, so two persons cannot take the last place. The pair (Activity, person) is a unique key for an RSVP answer and for a check-in. A check-in outside the window is refused. Spec 0006b decides the lock protocol: which existing root guards each write, and whether the Activity row is that guard. Activity is not a DDD aggregate by this ADR.

**Waitlist (proposed).** When the capacity is full, a `yes` is stored as `waitlisted`, in the order of the answers. When a `yes` becomes `no`, or the capacity grows, the oldest `waitlisted` person becomes `yes` in the same transaction, and the outbox gets a notice for that person. The waitlist stops at the RSVP deadline. Promotion rules are an open question.

**Jobs.** `System(activities)` is its own principal. It sends a reminder before the start to those who answered `yes` or `maybe`, and one before the RSVP deadline to those who have not answered. Each message has an idempotency key (activity, person, kind), so a repeated sweep sends nothing twice. The jobs are in the registry of spec 0008, and the generated jobs table lists them.

## Social events return to the core

ADR 0005 moved social events to Google Forms and Google Calendar because of low use: 10 social events exist in the 2024 backup. The operator input of 2026-10-27 is that the departments arrange social events by hand with Slack messages. The low count in the legacy tool may show that the legacy tool did not help, not that the need is small [INFERENCE: the legacy usage data cannot tell these two apart].

**Proposed revision of ADR 0005, for social events only.** Social events are rebuilt as the Activity type Social event. They are a **supporting** business process, not a core one: the system must do them well enough, with the least custom work, and with no rules of its own beyond the audience and the capacity. The system stays the source of truth, and Google Calendar becomes a projection of it (see Calendar). Surveys, team applications and certificate requests stay out of the core, as ADR 0005 says.

The legacy `SocialEvent` entity becomes the Activity type. The legacy rules map as follows:

| Legacy | In the Activity |
| --- | --- |
| RULE-188: title required, link at most 250 characters, end after start | Kept as validation of the Activity. The link is the external link field. |
| RULE-085: badge "Har vært" or "Skjer innen en uke" | Kept as a derived display value of start and now. |
| The role field "which users may sign up", which the legacy system never enforced | Replaced by the audience, which the system does enforce. |
| Department and semester | The unit (a department or a team in it), and the semester that follows from the start. |

The importer maps each legacy social event to an Activity of that type, with no RSVP answers (the legacy system has none).

## Slack as a client

The legacy Slack integration is **outbound only**. It posts through an incoming webhook with `nexylan/slack-bundle`, in a `SlackMessenger` with `notify` and `log` (RULE-212, RULE-249, RULE-266, RULE-268, RULE-273). The legacy code has no interactive bot. An earlier bot existed outside the code, and its use is unknown (operator input).

This ADR proposes an interactive Slack app. It is one more **client** in the sense of ADR 0008: software that acts on behalf of a principal, never with more permissions than the principal. It is a route of the one Worker, and not a second service.

### Identity: the Slack link

A **Slack link** is an explicit, recorded link between one Person and one Slack user id in the organisation's workspace. The `LinkCreated` record stores its source. A link may be provisioned automatically only when Slack's verified e-mail exactly and uniquely matches an address that belongs to exactly one person: a personal provisioned `@vektorprogrammet.no` address (spec 0008) or a verified registered address. Never use shared or role mailboxes, such as `okonomi@`. Record source as `auto: verified e-mail` or `manual: Sign in with Slack`. Anything else requires manual linking on Min side. If the matched address stops belonging to the person, the link ends, so reassignment cannot preserve the old link. The person sees and can remove the link on Min side.

1. For no eligible unique match, the signed-in person chooses "Link Slack" on Min side. The server starts the flow with a `state` and a `nonce`, and the `team` parameter set to the organisation's workspace.
2. Slack returns an `id_token`. The server checks the signature, the `nonce`, and that the team id is the organisation's workspace. It reads the Slack user id.
3. The server stores the person, Slack team id, Slack user id, creation source and time. The pair is unique in both directions. A second attempt on a linked Slack user id is refused until the first link ends.

The linking flow requests `openid` and `email` so it can use Slack's verified e-mail claim. It does not need the `profile` scope.

The signed-in session proves the Person. For a manual link, the verified OpenID flow proves control of the Slack identity. An automatic link uses the verified e-mail and the unique address-ownership rule above; an e-mail string alone never proves identity. The system never trusts display names or channel membership. A person ends the link on Min side. The link also ends when the account is deactivated or the person is erased (spec 0007b).

### What a click does

Every interaction runs the same command as the web does, with the same grant check. The Slack client is a narrowing: it may run only the commands below.

| In Slack | Command | Notes |
| --- | --- | --- |
| RSVP buttons in a direct message (yes, no, maybe) | `setRsvp` |  |
| Check-in button in a direct message | `createCheckIn` | Presence `declared` only |
| Check-in through the QR link | `createCheckIn` | The link opens a page in the browser or in the Slack app. Presence `scanned`. |
| Open vote | `castVote` (ADR 0012) | Open ballots only |
| Secret ballot | `castBallot` (ADR 0012) | Per-election `ballotChannel`: `SlackDM` or `Web`. The bot never writes the choice into a message. |

**Each election sets `ballotChannel` to `SlackDM` or `Web`.** With `Web`, the message carries only a single-use `Link(purpose)` (ADR 0011) for the person and round; Slack never receives the choice. With `SlackDM`, the button press sends the ballot through Slack as a processor. In neither channel does the bot write the choice into a message: it replies only "Your vote is recorded." Slack documents interactive callbacks ([handling interactions](https://docs.slack.dev/interactivity/handling-user-interaction)). Workspace owners may export private channels and DMs on some plans or after approval; availability depends on plan and approval ([Slack export guide](https://slack.com/help/articles/201658943-Export-your-workspace-data)). The operator has not verified the workspace's plan or export access. Slack DM ballot content is processor data. ADR 0012 owns the secrecy and unlinkability guarantees for either channel.

**The server decides on every click.**

- The server **checks the Slack request signature** with the app's signing secret on the raw body, and refuses a timestamp older than five minutes ([Slack documentation](https://docs.slack.dev/authentication/verifying-requests-from-slack)). An unsigned request does nothing.
- It looks up the Slack link from the Slack user id. With no link, no command runs: the reply is a private message with a link to Min side.
- It runs the command as that Person, through the client `slack`. The grant check, the state check and the data check run again, as they do for the web. A button in an old message does not give a right that the person has lost: someone who left the team gets a refusal.
- The audit entry names the principal, the client (Slack, with the Slack team and user ids) and the command. The same model lets a simulation drive the system (ADR 0008).

**The 3-second rule.** Slack needs an HTTP 200 within 3 seconds, or the person sees an error ([Slack documentation](https://docs.slack.dev/interactivity/handling-user-interaction)). The route verifies the signature, answers 200 at once, and runs the command after that (`waitUntil` in the Worker). Then it updates the message through the `response_url` that the payload carries, which stays valid for 30 minutes. The commands are idempotent: a repeated `setRsvp` with the same answer, and a second `createCheckIn`, change nothing. So a retry from Slack, or a click that the Worker lost after the answer, is safe, and the person can click again. There is no inbound queue.

### Messages

Notices go through the outbox of spec 0008: the command writes the outbox rows in its own transaction, and the provider call happens after commit. Mail and Slack are two channels of one message.

- A person with a Slack link gets a direct message with buttons. A person without one gets mail. Which channel a person wants is a setting on Min side; mail is the default until a Slack link exists.
- A message holds the least: the title, the time, the place, the buttons and a link to the Activity page. It holds no ballot content and no free text from a person.
- A department may also post the announcement to a channel. That post has a link to the Activity page, and no personal buttons. Channel membership never gives a right.
- Outside production the Slack adapter is the capture sink. A test posts a signed interaction to the same route with a test signing secret, and no real workspace is used. The structural environment gate of spec 0008 stays.

The new outbox message kinds (a direct message to a person, and an update of a posted message) are added to the tagged union that spec 0008 extends. Secrets stay out of persisted payloads.

## Calendar

Calendar export is **one way**, from the system to the calendar (ADR 0005). Two adapters are possible and share one port.

- **An ICS feed** ([RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)) needs no Google credential. A person subscribes to a personal feed of Activities in their audience. The feed address holds a secret that the person can renew.
- **A Google Calendar projection** writes Activities to a calendar of the unit, through spec 0008's Workspace writer. Repeating "ensure this event exists" has no extra effect.

Which adapter comes first is for the spec. No calendar writes back.

## Personal data

Each field is declared in `packages/domain` with its purpose, legal basis and retention (ADR 0004). This table is the proposal. The periods and bases are for the operator and the privacy owner to confirm.

| Data | Purpose | Kept for (proposed) |
| --- | --- | --- |
| RSVP answer: person, Activity, answer, time | Plan places and the number of persons | 30 days after the Activity ends, then deleted. Longer only if cost sharing needs it (open question). |
| Check-in: person, Activity, time, who recorded it | Attendance and the quorum | 30 days after the end. For an election: until the appeal window ends (ADR 0012). |
| Slack link: person, Slack team id, Slack user id | Send messages and accept clicks | While linked. Deleted at unlink, at deactivation and at erasure. |
| Calendar feed secret (if the ICS adapter is built) | Show a person their feed | Until the person renews or removes it |
| Slack interaction in the audit log: Slack user id, command | Show who did what, through which client | With the audit log (spec 0007b) |
| The Activity: title, time, place, organisers | Plan and show the Activity | Kept. The organisers are persons: the reference follows the retention of the audit log. |

Slack is a **processor** for the messages, and for the clicks that pass through it. Spec 0007b lists Neon, Cloudflare and Google Workspace; Slack joins that list. ADR 0004's precondition applies to it: an organisation-owned account with a data processing agreement before go-live. Slack keeps its own copy of messages by its own rules, which the system does not apply, as the contact form notice already says for mail and Slack.

## Operator gates

The system cannot do these steps. A human does them.

1. A **workspace admin installs the Slack app**: the Request URL, the redirect URL, the bot scopes (the fewest that post and open direct messages; the spec lists them) and the `openid` scope for Sign in with Slack.
2. The **bot token, the signing secret, and the app's client id and secret** are Worker secrets, set with `cf`. They never enter the repository or an outbox row. The bot token replaces the legacy incoming webhook, so the system has one organisation-owned Slack credential and no personal webhook (spec 0008).
3. The **Slack data processing agreement** (see Personal data).

## Considered options

- **Leave social events in Google Forms and Calendar, and in Slack by hand** (ADR 0005 as accepted). Rejected for social events: nothing ties an answer to a person, a unit or the audience rule, and people repeat the same message by hand. Accepted for surveys, team applications and certificates.
- **Replace Slack with the web only.** Rejected: the teams are in Slack, and a notice that people do not see is not a notice.
- **Build a Slack bot with its own rules.** Rejected: a second copy of every check. The bot is a client, so it can only run commands, and the grant table decides.
- **Link by any matching e-mail string, or by display name.** Rejected: an unverified address or a display name proves nothing, and a person can change both. Only Slack's verified e-mail that uniquely matches an address belonging to one person may provision a link (see Identity).
- **Use Sign in with Slack as the sign-in of the system.** Not chosen: sign-in stays as spec 0007 has it. Slack proves an identity for the link only.
- **One secret-ballot channel.** Rejected: each election chooses `ballotChannel`; Slack DM is allowed as a processor flow, while Web keeps the choice out of Slack. Both keep choices out of messages.
- **One entity per kind of occasion** (social event, meeting, election). Rejected: each needs the same schedule, audience and notices three times.
- **A queue for inbound Slack clicks.** Not chosen: the commands are idempotent, and a lost click can be clicked again.

## Consequences

- **Kernel.** Subject sets `Audience(a)` and `Organiser(a)` join the grant table (the Activity comes from the command's resource). `Link(purpose)` gets the purpose `ballot`. The command declaration gains `Activity`, `Rsvp`, `CheckIn` and `SlackLink` as resources (ADR 0010). The command's client can carry a narrowing set (ADR 0008).
- **Domain.** Activity types, capabilities and their bounds are `Schema` data in `packages/domain`. The audience rule is one function over role assignments. Runtime, UI, docs and tests read the declarations.
- **Docgen.** Generated blocks list the Activity types with their capabilities, and the Slack commands with their grants.
- **Jobs and outbox.** `System(activities)` is a new job principal in spec 0008's registry. The outbox union gains the Slack direct message and the message update.
- **Spec 0006b.** The lock protocol for capacity and check-in. The TLA+ model follows.
- **Spec 0007b.** The declarations of the table above, and Slack as a processor. Erasure deletes the Slack link and the RSVP and check-in rows.
- **Other ADRs.** On acceptance, ADR 0005 gets a revision line for social events, and `docs/system/README.md` moves social events from "Google Forms and Calendar" to "this system". ADR 0012's statement "ADR 0013 will define the Activity frame" is met by this ADR. This ADR changes nothing in them until then.
- **Formal checks.** The generated model adds:
  - _One answer._ A person has at most one RSVP answer and one check-in per Activity.
  - _Capacity._ The `yes` answers never exceed the capacity. A person is `waitlisted` only while the Activity is full, and a place that frees up goes to the oldest `waitlisted` person.
  - _Window._ A check-in exists only inside the window, and only for a person in the audience when it was made.
  - _Audience._ Nobody outside the audience answers or checks in. An external contact is never in an audience.
  - _Lifecycle._ No transition leaves Cancelled.
  - _Slack._ No command runs for a Slack identity without a link. No command runs without the same grant check as the web. No outbox row, captured Slack message or Slack payload holds ballot content (a scan, like the plaintext scan of spec 0007).
  - _Once._ Each reminder kind is sent at most once to each person for each Activity.

## Open questions

1. **Assistants as audience.** May some types include assistants (for example an onboarding day)? Assistants have a placement, not a team membership, and may have no account (ADR 0008). They would need a `Link` credential, because they cannot sign in.
2. **Cost sharing for social events.** Who pays, and how does the system record it? This belongs to the economy domain (spec 0012). It also decides how long RSVP data must be kept.
3. **Waitlist promotion.** Automatic or by an organiser? In the order of the answers? Until which time? What if a promoted person does not react?
4. **Who plans.** Are organisers a role kind in a unit (a privilege that a decision grants, ADR 0011) or any person in the audience? This ADR proposes the second for social events: the creator becomes the organiser, and it is a designation on the Activity, not a role. A type may restrict planning to the leader.
5. **Retention of RSVP data.** Is 30 days after the end right? Should only the numbers stay?
6. **The check-in code.** Must the QR code on the screen rotate? Is a static link enough for a meeting of known members?
7. **Slack data.** May a department post the announcement to a channel, and which channels? Which direct messages may a person turn off, and are some mandatory (a vote opens, an Activity is cancelled)?
8. **Calendar.** Which adapter first: the ICS feed or the Google projection? Who holds the feed secret, and how does a person renew it?
9. **Maybe.** Does a `maybe` after the deadline count as an answer, or as no answer? May a person answer `no` after the deadline to free a place?
10. **The legacy bot.** Where did the earlier bot live, and does anyone use it? The operator does not know its use.

Source: operator decisions, 2026-10-27. The legacy Slack facts are from `BUSINESS_RULES.md` (RULE-212, 249, 266, 268, 273) and the legacy code review; the social event facts are from `packages/domain/src/content/socialEvent.ts` (RULE-085, RULE-188) and ADR 0005.
