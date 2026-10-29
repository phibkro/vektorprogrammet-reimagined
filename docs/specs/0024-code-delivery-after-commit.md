# Spec 0024: Code delivery moves out of the transaction (spec 0007 R1; ADR 0015 section 10 rule 1)

**Status:** in progress; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** operator decision (2026-10-29): "code delivery moves out of the transaction"; spec 0007 R1 (the mint at delivery), spec 0008b (outbox on queues), spec 0020 (the tolerated `integrationCalls` entry), spec 0006b (Person aggregate lock), spec 0018/0019 (`InTransaction`) · **Branch:** `feat/code-delivery-after-commit`, from main `a85bab0`.

## Journey

A person asks for a code (an administrator invites her, she asks for a password reset, or the alumni job asks her) and uses it.

1. **Request.** The command commits an `IssueCode` outbox row that names the purpose and the person, and no code (spec 0007 R1: the outbox carries no plaintext). After the commit the queue (or a Preview's `waitUntil`) asks for the row's delivery.
2. **Transaction 1.** The delivery claims the row, locks the person (`AggregateLocks`), decides that a code is still due, mints 256 random bits and stores only their hash **`Unsent`**, replacing the person's older code of that purpose, whatever state it is in (RULE-220). The transaction commits. The plaintext is in the delivery fiber's memory (a `Redacted` value) and nowhere else.
3. **Send.** After the commit the delivery sends the mail with the link. No transaction is open. The send is at least once.
4. **Transaction 2.** The delivery locks the person again and moves **that code, by its hash, `Unsent → Usable`** (`Aggregates.apply`), and marks the outbox row delivered, in one commit. A claim that another consumer took meanwhile rolls it back.
5. **Use.** She presents the link. Only a `Usable`, unexpired code authenticates. A single-use code ends `Used`; the reusable alumni code stays `Usable` until it expires.

If she is quick (the mail arrives before transaction 2 commits) the link is refused like any unusable code, and works a moment later. If anything goes wrong between steps 2 and 4 the code stays `Unsent` and **cannot authenticate**; she recovers by requesting again (below).

## Goal, constraints, values

- **Goal:** no integration call inside a transaction, by construction where the types can say it and at run time where they cannot: (1) code delivery stores the code unusable, sends after the commit and acknowledges in a second transaction; (2) every integration port refuses a call made while a transaction is open on the calling fiber; (3) the `integrationCalls` exception of spec 0020 retires.
- **Constraints:**
  - The code's life is a state machine (`Machine.make`, declared terminal state) and an unusable code never authenticates, proved by a test.
  - Codes sit inside the Person aggregate's lock rules: both transactions take the person's lock; the new state is written only by `Aggregates.apply`. No advisory locks, `LISTEN/NOTIFY` or session `SET`.
  - The outbox carries no plaintext code. No new table and no new foreign key to `person`.
  - Clean cutover: `CodeRepository.replace` is gone, every caller moves; no shim.
- **Values:** the bad state unrepresentable (a state column with a check, a machine that has no transition from `Unsent` to use); one construct for the guard; every falsifier has a control.

## Decisions

**D1. The code mail rides the outbox as an intent, not as a message.** The outbox row `IssueCode { personId, purpose }` stays the durable record that a code is owed, and the queue, the claim, the retry policy and the dead-letter ending (spec 0008b) carry it unchanged. The mail itself is **not** an outbox `Email` row: its text is the link, and the link is the plaintext code, which the outbox must never hold. So the plaintext reaches the mail through the delivery fiber's memory between transaction 1 and the send, and a crash between them loses it harmlessly: the code is `Unsent` and the redelivery mints another. The alternative that was considered, storing an encrypted link in the outbox, adds a key and a second copy of a credential for no gain, since the redelivery path already exists. The decision was not an operator fork: it is forced by the written rule.

**D2. One row per purpose and person, as before; the older code goes at transaction 1.** The right answer is two slots (the old code stays usable until the new one is acknowledged, then the swap), which keeps a person with a working code from losing it to a send that never completes. It costs a key change on `code` (`(purpose, subject)` is the primary key, `UK1` and the personal data closure rest on it) and a retention and merge rule for two rows. It is not done here. What this spec accepts, and states: from transaction 1 until transaction 2 (or the next successful redelivery) the person has no usable code of that purpose. Recovery is to request again. A follow-up spec can add the second slot; nothing here prevents it.

**D3. The guard reads the transaction's own proof.** `Transactor.run` provides `InTransaction` to everything below it, in every provider (the PostgreSQL adapter and the in-memory test compositions). `refusingInTransaction` (`shared/integrationGuard.ts`) wraps every member of an integration port's service: a method refuses before it is called, an effect member before it runs, with `Effect.serviceOption(InTransaction)` in the **caller's** fiber. So a port that a Layer captured when it was built is checked at the call, a child fiber of the transaction is refused too, and nothing depends on which Transactor made the proof. The failure is the defect `IntegrationCalledInTransaction { call }` (the program is wrong; no handler recovers it). It is a runtime check on top of the type bound (`NotAnIntegration`), which stays as the early warning and is untouched.

**D4. The machine is not registered in a domain.** A transition names a command of the domain's `RpcGroup`, and the two delivery steps (`issueCode`, `acknowledgeCode`) have no endpoint and no grant: the delivery performs them as the system. Registering them as commands would change the grant table and so the effx conformance vectors (`packages/domain/conformance`, a Nix run of 10 to 24 CPU-minutes) for rows that no principal holds. `CodeMachine` therefore stands beside `AccountMachine` (`accounts/codeMachine.ts`), its commands are the two steps and the two commands that spend a code, and the generated reference draws it (`docs/system/accounts.md`, block `code-lifecycle`). Terminal: `Used`. Expiry is not a state (`expiresAt` is compared whole, as before); replacement is not a transition (the row is removed and a new row starts `Unsent`).

## The state machine as built

```
[*] --issueCode--> Unsent --acknowledgeCode--> Usable --activateAccount / resetPassword--> Used   (terminal)
```

`code.state` is `text not null` with `check (state in ('Unsent','Usable','Used'))` (migration `code_state`, which carries existing rows over: unused `Usable`, used `Used`, and drops `used_at`). `findUsable` selects `state = 'Usable'`; `consume` and `acknowledge` are `Aggregates.apply` transitions of `CodeMachine`, so each is one conditional `UPDATE … WHERE state = ANY(from)` with one winner.

## Requirements

| # | Requirement |
| --- | --- |
| R1 | **Transaction 1 stores, transaction 2 acknowledges, the send is between them and outside both.** `AccountDelivery.issueCode` is `store` (lock, decide, mint, `CodeRepository.issue`), then `MessageSender.send`, then `acknowledge` (lock, `CodeRepository.acknowledge`, `markDelivered`). The plaintext is held as a `Redacted` value. |
| R2 | **The lifecycle is `CodeMachine`.** `Code.state` is `Unsent \| Usable \| Used`; `codeTransition` is the table's transition that the repository applies. |
| R3 | **An unusable code never authenticates.** `findUsable`, `consume`, `codePrincipal` and every command that spends a code refuse an `Unsent` or `Used` code, in every purpose. |
| R4 | **A replaced or lost acknowledgement is harmless.** `acknowledge` is bound to the code's hash: an attempt whose code was replaced (or erased) acknowledges nothing and the row is delivered; it never makes another attempt's `Unsent` code usable. |
| R5 | **Crash safety.** A crash (a defect or an interruption) after the send and before transaction 2 leaves the code `Unsent`; the claim's lease runs out, the redelivery mints and mails another code, and only that one works. |
| R6 | **Integration ports refuse a call inside a transaction.** `MessageSender`, `TurnstileVerifier`, `Auth`, `WorkspaceDirectory` and `WorkspaceWriter` are built through `refusingInTransaction`. |
| R7 | **The exception retires.** `integrationCalls` in `tools/quality/moduleGraph.ts` is empty and the test pins it; before the entry was removed, `check:module-graph` failed on it ("no longer has MessageSender.send(…) inside Transactor.run(…)"), which is the retirement trigger firing. |
| R8 | **Documents follow.** `docs/system/accounts.md`, `store-guarantees.md`, `administration.md` are regenerated; `AGENTS.md`, the TLA+ confirmation and the exception registry are updated. |

## Failure cases and recovery

| Case | State afterwards | The person's recovery |
| --- | --- | --- |
| The provider refuses or is down | The code stays `Unsent`; the row is retried by the queue's policy (8 attempts) and each attempt replaces the code | Requests again once attempts are exhausted (reset), or waits for the retry |
| Crash after the send, before transaction 2 | `Unsent`; the mailed link is refused | The lease (120 s) runs out and the row is delivered again: a second mail, whose link works. If the row is dead, she requests again |
| Mail arrives before transaction 2 commits | `Unsent` for a moment; the link is refused as an unusable code | Tries again; it works once the commit lands |
| A newer request replaces the code | Only the newest code is `Usable`; the older mail is dead (RULE-220) | Uses the newest mail |
| The account changes between the transactions | The code is `Usable`, and `codePrincipal` refuses it at use (the account must still fit the purpose) | As for any code of that account |
| The person is erased or merged away between them | The code row is gone; `acknowledge` is false and the row is delivered | None needed |
| Another consumer took the claim during the send | Transaction 2 rolls back (claim lost); the code stays `Unsent` until that consumer replaces it | None needed |

Activation and the alumni consent mail have no self-service "request again": an activation resend and an alumni re-ask are not offered today, so a dead `IssueCode` row of those purposes is for an administrator (the Integrations page shows it). That is unchanged by this spec (before it, a failed send also left the row failed and the person without a code).

## Falsifiers

Each has a negative control that fails without the mechanism; the controls were run as mutations and their results are in Revision R2. `bun run test:all` and CI run the falsifiers; the commands and results are in the pull request.

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **Journey order.** At the moment of the send the code is committed `Unsent` (read from another connection) and its link is refused; after the send and before transaction 2 the same; after the delivery the link works and the row is delivered | M7: a delivery that never acknowledges; M2: a reader that ignores the state; M4: a send inside transaction 1 | `apps/web/test/codeLifecycle.postgres.test.ts` |
| F2 | **Crash between send and acknowledgement** (a defect, then an interruption, then a held claim, then a lapsed lease): mailed codes stay unusable; the redelivery's is the only one that works; the held claim sends nothing | M7; M4 | same |
| F3 | **The account changes between the transactions**: the acknowledged code is refused at use | M7; M4 | same |
| F4 | **Two requests.** Scripted: the older attempt's acknowledgement does not make the newer `Unsent` code usable, and the older mail is dead. Concurrent: exactly one of two mails works, in each of 100 fresh rounds, each loser's `Cause` printed | M1: `acknowledge` without its hash condition fails the scripted test; M2 fails it too; M7 fails the concurrent rounds | same |
| F5 | **An unusable code never authenticates.** For every single-use purpose and each of `Unsent`, `Used`, expired and `Usable`: `codePrincipal`, `findUsable` and `consume` answer only for the `Usable`, unexpired one, and a state-blind SQL read finds each row (so a refusal is the state's). The table has no transition from `Unsent` or `Used` to a use, every state is reachable from the boundary, and `Used` is terminal | M2: a reader that ignores the state; M2b: `activateAccount` and `resetPassword` allowed from `Unsent`; the table test's own mutant (a transition added in memory) is found by the same check | `packages/db/test/accounts.postgres.test.ts`, `packages/domain/test/accounts/codeMachine.test.ts` |
| F6 | **The guard on the real ports.** Every member of each shipped Layer (the capture sink and the production transport of `MessageSender`, both `TurnstileVerifier` Layers, `WorkspaceDirectory` and `WorkspaceWriter` in each deployment and mode), called inside `Transactor.run` from outside (a captured port, a forked child), dies as `IntegrationCalledInTransaction` and reaches no provider; outside a transaction the same call reaches it | M3: `refusingInTransaction` made the identity fails all five cases | `apps/web/test/integrationGuard.test.ts` |
| F7 | **The guard on PostgreSQL.** `MessageSender.send` and `Auth.session` inside the real `Transactor.run` die and leave no mail | M3 | `codeLifecycle.postgres.test.ts` (`F7`) |
| F8 | **The type bound still holds** | the existing assertions | `integrationInTransaction.types.test.ts`, `integrationPorts.types.test.ts` |
| F9 | **The exception is retired by the check, not by a comment.** With the restructured file and the entry still listed, `check:module-graph` fails with the stale-call finding; with the entry removed it passes and the test pins an empty list | The finding is the control | `tools/quality` |
| F10 | **Nothing else moved.** `vp check`, `bun run test:all`, `bun run ready`, the membership-writes model, and the accounts journey of the browser tests pass | — | CI |

## Not done here

- **Two code slots** (D2).
- **An activation resend and an alumni re-ask** for the person (see above).
- **Effect 4.1** and the `integrationCalls` check's other uses: the check and its fixtures stay; only the real list is empty.

## Revisions

### R1 (2026-10-29): paused before the verification run

The lead paused the lane while the machine was under memory pressure. Built and committed on `feat/code-delivery-after-commit`:

- the domain (`CodeState`, `CodeMachine`, the new `CodeRepository`, `refusingInTransaction`), the schema and migration `code_state`, the repository, `AccountDelivery` in three steps, the guard on all five ports, the retired `integrationCalls`, and the regenerated documents. `vp check` is clean (0 errors; the two new `any-unknown-in-error-context` warnings are the ones that `live.ts`'s `behindCheck` already has). These pass: the db suites `accounts`, `personalDataClosure`, `liveProof`; the web suites `codeDelivery`, `deliveryBoundary`, `outboxDelivery`, `alumniDelivery`, `workspace` and the new `integrationGuard` (5 tests).
- two test files are committed under the suffix `.wip` because the pre-commit lint (which may not be skipped) refuses them in their current form: `apps/web/test/integrationGuard.test.ts.wip` (it passed, 5 tests, before formatting; lint wants: no `async` fake for `SendEmail` (return a Promise from `Effect.runPromise`-free code or use `Effect.promise`), `Schema.is` for `IntegrationCalledInTransaction` instead of `instanceof`, `Arr.map`, and the unstable `HttpClient` imports need the same allowance that `sandbox.test.ts` has) and `apps/web/test/codeLifecycle.postgres.test.ts.wip` (**never run**; 54 lint findings: `SAFETY:` comments or helpers instead of `as`, `no-use-before-define` order of helpers, `Deferred<void>` via `Deferred.make<undefined>`/no `undefined` argument, a `Data.taggedEnum` for the mail literal, split `concurrentAttempts` for complexity, `Schema.is` for the defect). Rename each to its `.ts` name once it passes `vp check`.
- `outboxQueue.postgres.test.ts` (falsifier 6 now asserts an `Unsent` code after a failed send) is edited and has **not been run**.

### R2 (2026-10-29): resumed and finished

The pause's steps are done, in the order that R1 listed them:

1. The two `.wip` files are lint-clean `.ts` files. `integrationGuard.test.ts` joined the unstable-API policy of `sandbox.test.ts` (`EX-0011`, `unstablePolicy.ts`, its `asyncFunction` and `effecttsgo/async-function` overrides; `sync:effect-policy` rewrote `tsconfig.json`), because its fake provider is an `HttpClient` and a `send_email` binding.
2. F5 is written: `packages/domain/test/accounts/codeMachine.test.ts` and, in `accounts.postgres.test.ts`, a block over both single-use purposes and each of `Unsent`, `Used`, expired and `Usable`, with the state-blind SQL read as its control.
3. The new file `integrationGuard.ts` is allowed one `InTransaction` reference in `inTransactionProviders.test.ts`, and the file and `refusingInTransaction` are in `EX-0025` (the same cast pattern as `verified`); `check:exceptions` is clean.
4. **The mutation controls ran, each once, and restored.**

   | Mutation | What failed |
   | --- | --- |
   | M1: `acknowledge` without the hash condition | the scripted F4 (`expected ['Usable'] to deeply equal ['Unsent']`); the other five of `codeLifecycle` passed |
   | M2: `findUsable` without `state = 'Usable'` | F1, the scripted F4 and the F5 block (`activation, unsent: authenticates: true`) |
   | M2b: `activateAccount` and `resetPassword` allowed from `Unsent` in the table | two of the five tests of `codeMachine.test.ts` and the F5 block |
   | M3: `refusingInTransaction` returns the service unguarded | all five cases of `integrationGuard.test.ts` and F7 |
   | M4: a `send` inside transaction 1 | F1 to F4 (the guard dies, the row is `Retrying`; `check:module-graph` stays clean, since the entry is retired: the guard is what sees it) |
   | M7: transaction 2 never acknowledges | F1 to F4 and the 100 concurrent rounds |

   The retirement control of F9 ran before the entry was removed (the stale-call finding, in R7 above).

5. `AGENTS.md` (the "One Worker" and module-graph bullets), spec 0007 (R17) and the generated documents say the new shape.
6. The membership-writes model ran on `4d7b683` (every run as expected; the 53 PostgreSQL code tests passed with `--code`) and `SKILL.md` records the new digest and a paragraph: no statement, lock or constraint of `membership` changed.
7. `bun run ready` and the browser tests (`accounts.spec.ts` and `journey.spec.ts`, 7 passed) ran on the final tree; their results are in the pull request. Changes after that: none to the spec's falsifiers.

One thing the first draft got wrong: the F2 control "without the replacement of the older code leaves two working links" was not run. `issue` removes the older row before it inserts, and the primary key `(purpose, subject)` would refuse the insert otherwise, so that mutation does not run; M7 is F2's control.
