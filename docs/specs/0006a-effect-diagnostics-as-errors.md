# Spec 0006a: every Effect diagnostic is an error

Status: frozen 2026-10-27. Operator decision: "all effect tsgo/lsp warnings should be raised to errors". Stacked on spec 0006.

## Problem

The gate enforces only the `effecttsgo` rules in the `strict` and `effectNative` presets. Every other Effect language-service diagnostic stays at its default severity and never fails a check. Measured on `3568747` with `effect-tsgo diagnostics --project` over every package: **772 `unstableApiUsage` warnings** and **6 `schemaNumber` messages** (all in `packages/cms-client/src/generated.ts`). The unstable uses include the architectural bets of ADR 0006 (`effect/rpc`) and spec 0000 (`effect/sql`, `@effect/sql-pg`), which no record names. Effect 4.0.5 changed `Crypto.randomUUIDv4` from a property to a method inside 4.0.x, so the label is real.

## Contract

1. **Every `effecttsgo` rule the plugin exports runs at `error`**, not only the presets' rules. The rule list is read from the installed plugin, so a rule added by an upgrade is an error without a config change. A rule that is wrong for a file class gets the narrow, commented override the repository already uses.
2. **The language service agrees with the gate.** The `@effect/language-service` plugin in the tsconfigs reports every diagnostic at `error` (`diagnosticSeverity`), so the editor shows what the gate fails on.
3. **Unstable APIs: one allowlist, one source.** The allowlist is a module-level list, scoped by path where the API belongs to a layer:

   | Modules | Where allowed | Reason |
   | --- | --- | --- |
   | `effect/FileSystem`, `Path`, `Crypto`, `PlatformError`, `Stdio` | everywhere they are used | platform services, untagged in 4.0.0 |
   | `@effect/platform-bun/*`, `@effect/platform-node/*` runtimes and services | composition roots, tools, tests | process roots only |
   | `@effect/vitest`, `effect/Arbitrary`, `effect/rpc/RpcTest`, `@effect/sql-pglite` | tests | test infrastructure |
   | `effect/rpc` | everywhere | ADR 0006 (commands declared with Rpc) |
   | `effect/sql`, `@effect/sql-pg` | `packages/db`, `apps/web` server, tests | spec 0000 database path |
   | `@effect/sql-mysql2` | `tools/import` | legacy import only |
   | `effect/http` client modules | where used today | outbound HTTP (Turnstile, CMS) |
   | `effect/process`, `effect/cli` | `tools/**`, `apps/*/e2e`, `apps/cms/build` | tools only |
   | `effect/reactivity` | where used today | ADR 0009 (derived reactivity keys) |

   The existing member-level `allowedUnstableApis` list in `tsconfig.json` is replaced by this list, not kept beside it.

4. **Each row is an exception record** in `tools/quality/effect-exceptions.json` (the existing registry and its check): scope, the native alternative examined, verification, owner, Effect version examined (4.0.5), and the retirement trigger: _Effect marks the module stable, or a 4.0.x release breaks a member this repository uses (then that use moves behind an adapter)_.
5. **`schemaNumber`:** the CMS client generator emits a finite number schema where the OpenAPI document means a finite number, and the generated file is regenerated. A non-finite number, if the document allows one, is an explicit decision in the generator with its reason.

## Falsifiers

1. `bun run ready` passes on the committed tree, and `effect-tsgo diagnostics --project` over every package reports zero diagnostics of any severity.
2. **Negative control, rule coverage:** a probe file using an unstable API outside the allowlist (for example `effect/cluster`) fails `vp check`; removing the probe passes.
3. **Negative control, path scope:** `effect/process` imported in `packages/domain/src` fails; the same import in `tools/` passes.
4. **Negative control, new rules:** the rule list is derived from the plugin's exports (a test asserts that every exported `effecttsgo` rule is configured at `error`).
5. `check:exceptions` passes and every allowlist row has its record; removing one record fails the check.
6. The browser tests still pass (`bun run e2e`).

## Out of scope

Moving any unstable use behind an adapter (that happens when a retirement trigger fires). effx gets the same policy in its own change.
