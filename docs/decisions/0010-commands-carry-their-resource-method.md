---
status: accepted
---

# Every command names its resource and method; the HTTP API is derived from that

ADR 0006 stays: each command and query is declared once with `effect/rpc`, and it remains the unit of authorization (one grant), audit (one name) and state change (at most one transition). This decision adds one fact to each declaration, its **resource and method**, following Google's resource-oriented API rules (AIP-121, AIP-131 to AIP-136):

| Method | Use it when | HTTP shape derived from it |
| --- | --- | --- |
| `get`, `list` (queries) | reading one resource or a collection | `GET /teams/{team}`, `GET /teams?department={id}` |
| `create` | the command creates a resource (a transition from `[*]`) | `POST /teams/{team}/memberships` |
| `update` | the command changes fields and no state | `PATCH /people/{person}` with `If-Match` |
| `delete` | the command removes a resource | `DELETE /admin-grants/{grant}` |
| custom | anything else, in particular every other state transition | `POST /memberships/{membership}:extend`, `POST /accounts/{account}:deactivate` |

A standard method is the default. A custom method is the fallback for an intent that a standard method would blur: `extend`, `change` and `endEarly` all change a membership's end, but they differ in audit meaning and in transition. `extend` and `change` share `grant([leader, board], [...], "department")`; `endEarly` additionally has `grant([self], ["endEarly"], "own")`. So each is a custom method and none of them is an `update`. Names follow the method: `createTeam`, `updatePerson`, `deleteAdminGrant`, `extendMembership`.

A transition from the wrong state answers `409` (`Conflict`): that is ADR 0007's conditional transition, which conditions on state. A stale `If-Match` answers `412` only when a row version exists. This decision therefore requires an `update` that the derived HTTP API exposes with `If-Match` to carry a version column, checked in the conditional write. No such version exists today and no route is derived yet, so no declared `update` promises a `412`; an `update` that no route exposes with `If-Match` needs no version column (revision below).

## Considered options

- **REST verbs as the declaration, commands only where CRUD fails.** One `PATCH` would carry several intents with different grants, so authorization would read the request body to tell them apart: a second permission list. The audit would record "updated" where the intent was "extended".
- **Named commands only, no resource.** The current state. Correct, but an HTTP API, OpenAPI document or external client would have to be designed by hand, beside the declarations.

## Consequences

- The kernel's command declaration gains `resource` and `method`. The completeness test fails when a command has neither, and when a `create`, `update` or `delete` contradicts its transition (a `delete` that ends in a state, an `update` that changes one).
- The HTTP API is generated from the declarations (effx spec 0031, its `Operation` resource annotation), not written by hand, and only when a client outside the web app needs it. Until then the server functions stay the only HTTP surface (ADR 0006).
- Existing command names move to the convention in one mechanical change (`editTeam` → `updateTeam`, `renameFieldOfStudy` → `updateFieldOfStudy`, `extend` → `extendMembership`, and so on), with the grant table, docs and tests following.
- Built by spec 0007c (`docs/specs/0007c-command-resources.md`): the field, its checks and the rename (its table has the full mapping). The method has no field that could promise a `412`, so an `update` cannot claim one before a row version exists.

Source: operator decision, 2026-10-27.

Revision, 2026-10-27 (spec 0007c R2, after the review of PR 30): the requirement of the version column said "any `update` method". Spec 0007c declares four `update`s without one (`updateDepartment`, `updateFieldOfStudy`, `updateTeam` and `updatePerson`), none of them exposed over HTTP, and no field of the declaration promises them a `412`. The requirement now binds an `update` that the derived HTTP API exposes with `If-Match`, because the `412` is the one answer that needs a row version. Nothing else in this decision changes.
