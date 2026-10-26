---
status: accepted
---

# The domain declarations generate the formal models; the kernel moves to effx later

The kernel in `packages/domain/src/kernel/` declares commands (`RpcGroup`), grants, machines, principals and, from spec 0006 R4, guards as native Effect Schema checks. The same declarations will generate the formal models (Alloy 6 first, Quint and TLA+ when enabled), the documentation and the database constraints. Nobody writes a model by hand, so a model cannot disagree with the code. The predecessor mono-web kept a hand-written Alloy model and a Context Mapper model beside its code; both were second copies of the domain.

The kernel uses the names and shapes of effx spec 0031 (`docs/specs/0031-domain-model-extension.md` in the effx repository): Entity, Relationship, Machine, Guard, Event, Invariant, Principal, Grant, Job and Requirement. It stays in this repository until a second domain uses it. When spec 0011 (placement) is that second domain, the kernel moves into an effx package and this repository depends on it.

Grants (ADR 0001) stay the declaration of who may do what. Cedar policies, if wanted, are generated from the grants; they are never written by hand.

## Consequences

- Spec 0015 (simulation and model checking) generates the Alloy model from the kernel and replays its traces through `Commands.endpoint`, instead of driving random command sequences only.
- A guard or invariant is a Schema check with a `representation` id. A comparison that Effect does not provide (one field against another, `not`, `or`) gets a project id and a reviver; the set of ids is closed.
- Queries and commands declare which entities they read and write, so the client's `reactivityKeys` can be derived.
- Until the move, no slice here depends on an unpublished effx package.

Source: operator decision, 2026-10-26.
