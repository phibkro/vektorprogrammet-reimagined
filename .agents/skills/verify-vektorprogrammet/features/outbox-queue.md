# Outbox delivery on Cloudflare Queues

A command commits its outbox rows, and the Worker then puts the rows' ids on a Cloudflare Queue; the Worker's own `queue` handler claims each row, delivers it, and acknowledges the message (spec 0008b). The PostgreSQL outbox stays the record: a queue message is an id and nothing else. On this stack the dev server declares the queue and its dead-letter queue in Miniflare, which runs the Worker's real `queue` handler, so a message delivered here took the same path as on `main`. Nothing is sent to a real provider: the consumer builds the capture sink (`captured_mail`, `captured_slack`). The deployed queue (Cloudflare Queues, its consumer and its dead-letter queue) is not on this stack: `main` after the merge is its first real run, and a Worker Preview has no queue at all (a Preview cannot own a queue consumer), so it delivers in `waitUntil`.

## Sub-features

- `queue-delivery` a committed command's mail reaches `captured_mail` within seconds, by way of the queue: its outbox row has `queued_at` set and `status` `delivered`, and the dev server's log has a `QUEUE vp-outbox-local <n>/<n>` line for the batch.
- `queue-receipt` the receipt of the queue (`queued_at`) is a second fact beside `delivered_at`: on this stack every delivered row has both.
- `integrations-outbox` the `Utsendelser` card on `/kontrollpanel/integrasjoner` counts the rows by status (`Levert: <n> · Venter: <n> · Mislyktes: <n>`) and lists what is not delivered, each as `Venter på kø`, `I kø`, `Prøver igjen` or `Mislyktes`, with the class of the last error and never the message.
- `queue-holds-ids` nothing on the queue but ids: the stored rows are the only copy of an address or a text.

## How to get to it (user POV)

- Send a message from `/kontakt/<department slug>` (see [contact form](./contact-form.md)): the department's mail, the sender's receipt and the Slack posts are outbox rows.
- Open `/kontrollpanel/integrasjoner` as an administrator and read `Utsendelser`.
- Trigger the tick that the cron would: `GET <origin>/cdn-cgi/handler/scheduled`.

## Driving it with verify-vektorprogrammet

Preconditions:

- A fresh instance from `scripts/launch.sh` with `scripts/doctor.sh` at `DOCTOR OK`, and the machine can reach `challenges.cloudflare.com` (the contact form's Turnstile widget).
- `scripts/probe.sh "select count(*) from outbox" --name outbox-before`.

Steps:

- **The story.** Run `scripts/drive.sh public.spec.ts -g "falsifier 3"`: the contact form's valid post commits its outbox rows, and the spec waits for the capture sink to hold the Slack post. That wait now lasts for the queue (up to about a second of batching) and the consumer. Exit code `0`.
- **Stored state, the receipt.** `scripts/probe.sh "select id, kind, status, attempts, queued_at is not null as queued, delivered_at is not null as delivered from outbox order by id" --name outbox-after`: each new row is `delivered`, `attempts` 1 and `queued` true. A row that is `delivered` and not `queued` means the queue was bypassed, which is the path of a Worker Preview and of nothing else.
- **The consumer ran.** `grep "QUEUE vp-outbox-local" <run directory>/serve.log`: one line per batch, `n/n` of the messages handled, and `grep -c "outbox message captured" <run directory>/serve.log` grows by the number of new rows. `serve.log` never holds a message body, and the queue never held one: a message is an id.
- **The page.** `scripts/page.sh /kontrollpanel/integrasjoner --as "Ada Admin" --name integrations-admin` prints `200` and the text `Utsendelser` with `Levert: <n> · Venter: 0 · Mislyktes: 0` and `Alle meldinger er levert.`; `--as "Lise Leder"` prints `403`. `scripts/shot.sh /kontrollpanel/integrasjoner integrations-outbox --as "Ada Admin"` for the card. The committed spec `scripts/drive.sh integrations.spec.ts` also asserts the heading and the counts line.
- **Proof.** `scripts/report.sh --features "queue-delivery, queue-receipt, integrations-outbox, queue-holds-ids"`; attach the drive log, `results-<n>.json`, `probes/outbox-before.txt`, `probes/outbox-after.txt`, the page capture of `Utsendelser` and the `serve.log` excerpt.

## Gotchas

- Miniflare delivers a batch after at most one second (`max_batch_timeout`), so a mail is in `captured_mail` about a second after the response, not in it: poll, as the specs do.
- The consumer runs in the dev server's Worker, so `serve.log` holds both the request's and the consumer's lines; an `outbox delivery failed` warning, if any, names the outbox id and the attempt, never a body.
- A Worker Preview delivers in `waitUntil` and its rows have no `queued_at`; do not read a missing receipt on a Preview as a fault, and do not claim the queue verified from a Preview.
- Not drivable from the browser on this stack, and so not verified by it: `Prøver igjen` and `Mislyktes` rows (the capture sink never fails, and `scripts/probe.sh` is read-only, so no row can be made to fail), the sweep's re-enqueue of an old row, and Cloudflare's deployed Queues (retries over hours, the dead-letter queue, 14-day retention). The package tests cover them: `packages/db/test/outbox.postgres.test.ts` (the states of the overview and the sweep's query), `apps/web/test/outboxQueue.postgres.test.ts` (the sweep through the real job, with its control) and `apps/web/test/outboxQueue.worker.test.ts` (the retries and the dead-letter route in Miniflare). The first deployed run is `main`.
