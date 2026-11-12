---
status: accepted
---

# A fact that one machine owns is a query everywhere else

A state belongs to the machine that decides it. Another domain reads that fact; it does not store a second state that must move with it. The operator accepted this decision on 2026-11-12. It changes the designs below; it does not describe the current implementation. Claim recovery and the proposed answers below remain subject to review.

## Decisions

- **Placement.** Application's outcome ends at Accepted or NotAccepted; an accepted application can also be withdrawn. Whether it is placed is a query: a Placement in state Placed for that application exists. Placement owns that fact. `place` and `unplace` do not move Application. This replaces the cross-domain Application transitions in `../system/admission.md` and `../system/placement.md`.
- **Versioned documents.** An interview Form and public content use one construct: immutable published versions, an optional draft slot and a retired flag. Editing a draft does not unpublish the current version. A response keeps its FormVersion. Publication creates a version; retirement is distinct from editing. This refines ADR 0003 and the Form design in `../system/recruitment.md`; public content already has separate published and draft snapshots.
- **Calculated transitions and reactions.** A change calculated from time has no transaction at the instant it becomes true. Every reaction to it uses a scheduled detector and an idempotent claim committed in the same transaction as its outbox rows. A retry can find the claim without enqueuing the reaction again. Delivery after commit remains at least once. The alumni consent request and spec 0009b's `alerts_enqueued_at` claim are the patterns; spec 0009b owns the admission alert design.
- **Claim recovery (proposal).** A mistaken Rejected or Refunded expense claim stays terminal. A new claim references it and records the correction; the economy team checks any earlier payment before approving it. The bank payment is outside the system.

The kernel declares commands of one domain in each machine (ADR 0007 and ADR 0009). A Placement command cannot be an Application transition. Nor can a flat `Published → Draft` transition express a published version and a draft existing together.

## Consequences

- Application and Placement cannot disagree because there is no stored Application copy of placement state. Reads that show placement query Placement.
- The Form and public-content designs describe versions and the draft slot separately, not as mutually exclusive states. Existing responses continue to refer to their published version.
- A scheduled detector must recover after a missed run and commit its claim with its outbox work. An external provider is called only after commit.
- The live Application machine currently has Submitted and Withdrawn only (spec 0009). Later slices must implement the accepted outcome and placement design; these documents do not claim it is built.

## Derived facts

| Fact shown | Owner | Read |
| --- | --- | --- |
| Application placed | Placement | A Placed Placement exists for the application. |
| Interview Invited / Scheduled on application status | Interview (recruitment) | Read the linked Interview invitation and scheduling facts, not a stored Application copy. |
| Interview cancelled | Application | A Planned Interview is cancelled when its Application is Withdrawn or NotAccepted. |
| Interview score | Response and its FormVersion | Calculate from the answers and their immutable version. |

## Proposed answers — pending operator review

These answers are proposals, not part of the accepted decision. The operator must review them before they bind.

### `recordOutcome`

- **States and guards.** An authorized department recruiter or leader can move a Submitted Application to Accepted or NotAccepted only when its linked Interview is Completed. The returning-assistant `submitReturning` path remains separate and needs no interview.
- **Owner and refusals.** Application owns the outcome; Interview owns completion. The command reads completion under the relevant transaction locks and refuses a missing, Planned or derived-cancelled interview, a withdrawn or already decided Application, and unauthorized callers. It stores neither interview completion nor score on Application.
- **Corrections and audit.** A mistaken outcome is not overwritten by another `recordOutcome`. A separate authorized correction must record the prior and replacement decisions, actor, time and reason in the audit trail, with any downstream effects handled explicitly. Its transitions and placement consequences require operator review before implementation.
- **Rejected alternatives.** Recording from a Planned interview allows an outcome without completed evidence. Copying interview completion to Application creates a second owner. Automatically changing a decision when a score changes replaces human judgment.

### `correctResponse`

- **States and guards.** An assigned interviewer can correct a Completed Interview response both before and after an Application outcome. The Interview remains Completed. The corrected answers must decode against the original immutable FormVersion.
- **Owner and refusals.** Interview owns the response; Application owns the outcome. The command refuses a Planned or derived-cancelled interview, a missing response, an unauthorized caller, invalid answers and a request to change the response FormVersion. It does not change the outcome or store a score.
- **Corrections and audit.** Record the actor, time, reason and the previous and replacement answers in a protected audit history, subject to the response retention and access rules. The score is recalculated from the current answers. A correction after an outcome flags the decision for human review; it never changes it automatically.
- **Rejected alternatives.** Forbidding corrections after an outcome preserves known errors. Silent overwrite loses accountability. Editing the published FormVersion changes the meaning of other responses. Storing a score or outcome copy can disagree with its owner.

Source: `../system/admission.md`, `../system/recruitment.md`, `../system/placement.md`, ADRs 0003, 0007, 0009 and 0013, and specs 0008 and 0009b.
