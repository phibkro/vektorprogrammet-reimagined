# Spec 0008b: Outbox delivery on Cloudflare Queues

**Status:** frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** the operator's approval of the direction (2026-10-27: stay on Cloudflare and Neon, Queues for outbox delivery, the PostgreSQL outbox stays the only source of truth); `../../analysis/vektorprogrammet/research/hyperdrive-and-long-running.md` §H; specs 0007 and 0008. Stacked on spec 0008 (PR #37, merged), which owns the mail and Slack adapters.

## Journey

1. A leader adds a new member. The command commits the membership and its welcome messages as outbox rows in one transaction, as today.
2. Right after commit, the Worker puts the outbox ids on a Cloudflare Queue. The welcome mail arrives within seconds, not at the next cron tick.
3. The mail provider fails for a while. The queue retries with backoff; the administrator's Integrations page shows the message as retrying, then as failed if it never goes through.
4. The Worker crashes between commit and enqueue. Nothing is lost: the cron sweep finds the row still pending and enqueues it.

## Goal, constraints, values

- **Goal:** managed delivery (retries, backoff, dead-letter queue) and low latency, with the PostgreSQL outbox kept as the only record of what must be sent.
- **Constraints:**
  - **The outbox stays the source of truth.** A command never calls `queue.send()` instead of writing an outbox row: commit-then-send loses messages on a crash, send-then-commit sends messages for facts that rolled back (research §H, the dual-write gap).
  - **The queue message is the outbox id only.** No content, no address, no personal data on the queue (Queues retains messages up to 14 days on Paid, 24 h on Free; research §H).
  - **At-least-once and unordered** (Cloudflare Queues delivery guarantees): the consumer claims the row conditionally (`… where status = 'pending'`) and a second message for a delivered id does nothing. Provider-side duplicates remain possible after a send that succeeded before the row was marked; the outbox id is passed to providers that accept an idempotency key.
  - **Two receipts, not one:** "accepted by the queue" and "delivered by the provider" are separate states; the row is `delivered` only after the provider call returns.
  - **Code mail keeps spec 0007 R1:** the consumer mints, sends and acknowledges a code in its own transaction, exactly as the sweep does today.
  - **The sweep becomes a safety net:** `System(outboxSweep)` enqueues rows pending longer than a threshold (one declaration) and no longer delivers them itself.
  - **The dead-letter queue maps to an outbox state** (`failed`, with the last error class, no message content), visible on the Integrations page.
  - **Only production sends:** outside production the consumer delivers to the capture sink (spec 0008's structural gate).
  - Hyperdrive rules unchanged; queue and consumer declared in Alchemy; no new secret.
- **Values:** one source of truth for what must be sent; managed retries over hand-rolled ones.

## Falsifiers (each with a negative control)

1. A command whose transaction rolls back leaves no queue message and no delivery. Control: a variant that enqueues before commit sends one.
2. A crash injected between commit and enqueue still delivers, via the sweep, within the threshold. Control: with the sweep disabled, the message is never delivered.
3. Two deliveries of the same outbox id call the provider once (300 rounds, fresh state, losers' Cause printed). Control: without the conditional claim, the provider is called twice in some rounds.
4. A provider that fails N times then succeeds is retried and the row ends `delivered`; one that always fails ends `failed` after the declared attempts, through the dead-letter queue.
5. A scan of every queue message in the test run finds no personal data (only ids).
6. Code mail: the code is minted and acknowledged in the consumer's transaction; a failed send leaves no usable code (spec 0007's existing falsifier, re-run on the queue path).
7. Outside production nothing reaches a real provider (spec 0008's structural test, re-run).

## Resolutions of the open questions

These are the proposals that this slice builds. Each is one declaration or one sentence that the operator can overrule by changing that one place.

1. **The sweep's threshold and the number of attempts are one declaration each, proposed: 10 minutes and 8 attempts.** `DeliveryPolicy` in `packages/domain/src/outbox/declaration.ts` holds `requeueAfter` and `attempts` (with the retry delay's base and cap, which are the 5 minutes and 12 hours that spec 0008's hand-rolled schedule already used). The Queue consumer's `max_retries` in `apps/web/alchemy.run.ts` is read from `attempts`: Cloudflare delivers a message `max_retries + 1` times, so `max_retries = attempts − 1`. Miniflare shows the same count (`max_retries: 2` gave three deliveries, then the dead-letter queue).
2. **A Worker Preview cannot own a queue consumer, so it has no queue.** Cloudflare's Previews documentation says "Queue consumers cannot target a Preview": a Queue has one consumer Worker, and the Queues service does not register a Preview as that consumer. A Preview that produced to the stage's queue would have its ids consumed by `main`'s deployed Worker against `main`'s database, so the id would name another database's row. The binding is therefore declared for the `production` and `main` stages only, and the Worker chooses its path by the binding's presence: with `OUTBOX_QUEUE` the committed ids go on the queue; without it (a Preview) the same ids are delivered in `ctx.waitUntil`, to the capture sink, exactly as spec 0008 does. A Preview has no cron, so it has no sweep, as before. The Preview therefore shows the commit, the delivery to the capture sink and the Integrations page, and the queue path itself is first exercised on `main` after the merge.
3. **`failed` is the existing `dead` status.** The outbox status enum already has `pending`, `delivered` and `dead`; the Integrations page names `dead` "Mislyktes" (failed). No enum value is renamed, so no migration touches the status.
4. **The receipt of the queue is one column.** `outbox.queued_at` (nullable, bookkeeping with no value about a person, declared in `packages/domain/src/outbox/personalData.ts`) is when the queue last accepted the row's id. It is a second receipt beside `delivered_at`, and the sweep reads it: a pending row is stale when the later of its last receipt (`queued_at`, or `created_at` when it has none) and its `next_attempt_at` is older than `requeueAfter`, and no live claim holds it.
5. **Per-key ordering** is not provided by Queues and no current message kind needs it. A kind that does needs its own design (research §H).
6. **K2 is out of scope** (operator question, 2026-10-27). It is not the store of record: retention is at most 30 days, delivery is at-least-once without deduplication, there is no ordering across consumers sharing a subscription, and it is in public beta (research §H). The permanent record stays in Neon (the audit log and the outbox rows, written in the command's transaction). K2 is a later option as a replayable stream fed from the outbox when two or more independent consumers need the same events (a reporting projection, a Workspace projection, a Slack activity feed).

## Note

Mail already goes through Cloudflare's Email Service binding (`apps/web/src/server/senders.ts`), so this spec changes only how the outbox reaches the senders, not the senders.

## Revisions

### R1 (2026-10-28): what the build decided, written with the code

The contract above stands: the journey, the constraints and the seven falsifiers are unchanged. These are the decisions that the code of main (`f4bfe78`) forced or allowed, each under the contract.

1. **Delivery is by id, and the queue schedules it.** `OutboxDelivery.claimDue({ limit, ids? })` is replaced by `claim(id, leaseSeconds)`: one conditional `UPDATE` (`status = 'pending'`, no live claim) that answers `Claimed(row)`, `Held` (another claim is live: the message is retried after the lease) or `Settled` (delivered, failed or gone: the message is acknowledged). The claim no longer asks whether the row is due: the queue's retry delay is the schedule, and a duplicate message that comes early costs one extra attempt of a send that is idempotent by the row's id. The sub-millisecond claim race of spec 0007 R14 (issue #21) cannot occur any more, because there is no due-comparison; its test was removed.
2. **Three commands, one principal.** `sweepOutbox` now only finds the pending rows that no receipt covers and the job puts them on the queue; `deliverOutbox` (by ids) is the consumer's, and the Preview's direct delivery; `failOutbox` is the dead-letter queue's consumer's. All three are granted to `System("outboxSweep")` alone, so the effx description of the outbox domain and its vectors were regenerated at the pinned effx commit (`packages/domain/conformance/outbox.*`).
3. **The queue owns the attempts.** The consumer never decides that a row is dead: a failed delivery releases the claim, records the class of the failure in `last_error`, dates `next_attempt_at` by `DeliveryPolicy.retryDelay`, and answers `retry` with that delay. After the declared attempts Cloudflare moves the message to the dead-letter queue, whose consumer marks the row `dead` unless it was delivered meanwhile or a live claim holds it (`markDead`; it keeps the class of the last failure, and empties a credential intent's hash as delivery does). `MAX_ATTEMPTS` and `nextAttemptAfterFailure` are gone.
4. **Reasons are classes.** A provider's error text can name its recipient, so `DeliveryFailed.reason` is a class (`send_email rejected`, `slack <ErrorTag>`, `code email delivery failed`), which the row keeps and the Integrations page shows.
5. **A job publishes its own rows.** A commit's ids are published in the request's `waitUntil`; a job's chunk publishes the ids it enqueued once the chunk (and its cursor) have committed (`publishingAfterCommit` in `jobs.ts`). Without it the digest and alumni mail would wait for the sweep's threshold. The sweep's place at the end of the tick no longer decides anything.
6. **Activation and reset stay synchronous.** `runDeliveryChecked` delivers the credential intent in the request and reads the result (503 when it did not go through), by the same claim as the consumer. A row that failed there is on the queue only by the sweep, after `next_attempt_at` and the threshold.
7. **The binding decides the path.** `OUTBOX_QUEUE` present: the publisher sends the ids (`text`, 100 to a call) and writes `queued_at`; absent (a Preview): the direct publisher delivers in `waitUntil`, to the capture sink. A send that fails is logged by its class and leaves no receipt, so the sweep covers it.
8. **The Integrations page shows the outbox.** `Utsendelser` counts the rows by status and lists the undelivered ones (`Venter på kø`, `I kø`, `Prøver igjen`, `Mislyktes`) with the attempt count, the next attempt and the class of the last error, from `OutboxReports` (a read of `viewIntegrations`, so no grant row changed). It holds no payload.
9. **Local runtime.** `vp dev` declares the queue and its dead-letter queue (`apps/web/vite.config.ts`, `localQueues`) and Miniflare runs the Worker's real `queue` handler against them, so the browser suite delivers through the queue (the dev server's log shows `QUEUE vp-outbox-local 2/2`). The retries and the dead-letter route are exercised in Miniflare by `outboxQueue.worker.test.ts`, with a test Worker over the real consumer and database, a provider that fails a scripted number of times and a zero retry delay (`RetryDelay`, a `Context.Reference` whose default is the policy). A recording stand-in for the queue (`support/fakeQueue.ts`) serves the PostgreSQL tests; its rules are the ones the Miniflare test observes.
10. **Personal data and queues.** `outbox.queued_at` is declared in `packages/domain/src/outbox/personalData.ts` as bookkeeping with no value about a person; the closure test passes. No new table, no new foreign key to `person`, no change to a table that the Person root owns: the membership model was not run, because none of its covered files changed.

**Falsifier evidence and controls.** The commands are in the report of the pull request.

| Falsifier | Evidence and negative control |
| --- | --- |
| 1 | `outboxQueue.postgres.test.ts`: the committed command's id is on the queue only after the commit (`publishCommitted`), with the receipt; a command that rolls back leaves no row, no message and no provider call. Control: a message sent inside the transaction is on the queue for a row that rolled back. |
| 2 | Same file: the commit succeeds and the publication never runs (the Worker died); a tick before the threshold finds nothing, the same row aged 11 minutes is put on the queue by the real `outboxSweep` job (`runTick`), a second tick sends nothing twice, and the consumer delivers it. Control: with no job in the tick the row stays pending and nothing is ever sent. |
| 3 | Same file: two concurrent consumer runs for one id call a counting provider once, in each of 300 fresh rounds (each loser's `Cause` is printed on failure). `packages/db/test/outbox.postgres.test.ts`: 20 concurrent claims of one row give exactly one `Claimed` in each of 100 fresh rounds. Control: a delivery that reads the row and sends without the conditional claim calls the provider twice in some of the 300 rounds. Mutation: dropping the live-claim condition from `claim` makes the 300-round test fail in every round (`[ '1', '1' ]`) and the 20-claimer test fail, and restoring it makes both pass. |
| 4 | `outboxQueue.worker.test.ts` (Miniflare, real queues, the deployed consumer's settings): a provider that fails 3 times and answers is delivered on the fourth delivery of one message; a provider that always fails is delivered `DeliveryPolicy.attempts` (8) times and then once to the dead-letter queue, and the row ends `dead` with the class of its last failure. Control: the same provider without a dead-letter queue leaves the row `pending` after the 8 deliveries. |
| 5 | Every body that the PostgreSQL tests sent (the fake queue's record) and every body that the Miniflare consumer was given is an outbox id (`QueueBody`: digits only); the scan finds a message that holds an address (control). |
| 6 | `outboxQueue.postgres.test.ts`: an invitation's `IssueCode` message is published, the consumer's delivery fails (provider down): the code was rolled back (no usable code), the row is `pending` with `code email delivery failed`, no mail; the retry mints the code, sends the mail and acknowledges in one transaction, the mail's link is usable (`codePrincipal`), and the queue held the one message throughout. The spec 0007 scan (`codeDelivery.postgres.test.ts`) and its 1,000-round re-delivery run on `deliverOutbox` by id. |
| 7 | Same file: a message consumed by `runQueue` in `preview` reaches the capture sink and never the `SEND_EMAIL` binding; the same message in `production` reaches the binding (control). `sandbox.test.ts` (spec 0008) still refuses the production senders outside production. |

**Operator gate.** The deploy of the base stage `main` creates the queues and their consumers, so the CI token `vektorprogrammet-reimagined-ci` needs Queues Write before this is merged (`STATE.md`, `apps/web/README.md`); a Preview deploy needs nothing new.

**Not run, and why.** The deployed queue (Cloudflare Queues, its consumer, the dead-letter queue, 14-day retention) is not run from here: the PR's Worker Preview has no queue by design (Resolutions item 2), and `main` after the merge is its first run. Production is an operator step. K2 is out of scope.
