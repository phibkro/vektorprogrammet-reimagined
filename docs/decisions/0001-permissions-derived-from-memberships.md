---
status: accepted
---

# Permissions come from memberships, not from a role table

What a person can do comes from their current memberships and placements, through each team's function (board, economy, IT, recruitment, placement, other), plus an explicit admin list whose places expire. There is no role table and no access-rule table. A grant is (subject set, commands, scope). Grants only add up, there are no deny grants, and every command no grant covers is refused.

The legacy system kept roles beside memberships and recalculated them with a job. Its route rules allowed every route that no rule named (SEC-017, RULE-301). Two copies of "who may" disagreed, and the fallback was open. A role derived from memberships cannot disagree with them.

## Considered options

- **A role table with manual assignment.** Rejected: it is a second copy of membership and goes stale when terms end.
- **Allow and deny rules with precedence.** Rejected: precedence makes access hard to predict. Without deny rules, access is the union of grants.

## Consequences

- One grant table is the data of `authorize`, the test oracle of `authorize`, and the "who does what" tables in `docs/system/`.
- A team that has no function set gives its members no extra permissions. Departments must set functions (`docs/system/teams.md`).

Source: `../../../../analysis/vektorprogrammet/INFORMATION_MODEL.md` §9.2, §11.5.
