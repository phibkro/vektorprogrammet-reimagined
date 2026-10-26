---
status: accepted
---

# Commands are declared with `effect/rpc`, behind TanStack Start server functions

Each command is an `Rpc.make(name, { payload, success, error })` in one `RpcGroup` per domain, annotated with its machine transition. Handlers are implemented with `RpcGroup.toLayer`. TanStack Start server functions stay the only HTTP surface: they decode the input and call the group through an in-process client. The command declarations are data that the grant table, the completeness tests and the documentation generator read.

`Rpc.make` is Effect's own construct for a named operation with schemas for input, success and failure, so the declaration needs no house type. occupational-health uses the same pattern (`RpcGroup.toLayer` handlers called in-process through `RpcTest.makeClient`).

## Considered options

- **A plain house `Command` record next to `createServerFn`.** One dispatch layer fewer, but a home-made description where a native one exists.

## Consequences

- `effect/rpc` is marked `@stability unstable`. The exact pin of `effect` in the catalog contains it, and an upgrade must re-run the command tests.
- Server functions contain no rules: decode, call the command, map the outcome.

Source: `../../../../analysis/vektorprogrammet/INFORMATION_MODEL.md` and the 2026-10-26 operator decision on construct choice.
