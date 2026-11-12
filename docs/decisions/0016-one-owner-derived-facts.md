---
status: proposed
---

# A fact that one machine owns is a query everywhere else

A state belongs to the machine that decides it. Another domain reads that fact; it does not store a second state that must move with it. This proposal changes the accepted designs below; it does not describe the current implementation.

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
- The live Application machine currently has Submitted and Withdrawn only (spec 0009). Later slices must implement the proposed outcome and placement design; these documents do not claim it is built.

## Open questions

1. Should the legacy info meeting return, perhaps as an Activity type under ADR 0013?
2. Should applicants see “invited to interview” now that scheduling is in Calendar (spec 0008)?

Source: `../system/admission.md`, `../system/recruitment.md`, `../system/placement.md`, ADRs 0003, 0007, 0009 and 0013, and specs 0008 and 0009b.
