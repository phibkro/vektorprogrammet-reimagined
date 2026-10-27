# Contact form

A visitor writes to a department from the public site. Cloudflare's Turnstile widget guards the post; a valid post queues the department's e-mail, the sender's receipt and Slack posts in one transaction, and a refused post queues nothing. Nothing is sent from a local instance: the capture sink records each message instead (spec 0005, falsifier 3; RULE-156, RULE-167, RULE-249).

## Sub-features

- `contact-tabs` the department tabs on `/kontakt` move to `/kontakt/<slug>` and show that department's form.
- `contact-send` a valid browser post ends on the receipt with the department's address and queues the messages.
- `contact-refused` a post with no Turnstile answer is refused with 422 and queues nothing, and the visitor's text stays in the form.
- `contact-nojs` the same post without JavaScript, as a plain HTML form post: 303 to the receipt on success, 422 when the Turnstile answer is missing, 403 without an `Origin` header.
- `contact-receipt` `/kontakt/avdeling/<id>` answers 301 to the department's own page (the legacy receipt address).
- `contact-capture` each queued message reaches `delivered` through the capture sink, with no outside call for mail or Slack.

## How to get to it (user POV)

- Open `/kontakt`, choose a department in the `Velg avdeling` navigation, fill the form and choose `Send melding`.
- Open `/kontakt/<department slug>` directly (for example `/kontakt/alfaby`).
- Post the HTML form without JavaScript: `POST /kontakt/<slug>` with the form's fields.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK` and the machine can reach `challenges.cloudflare.com` (the harness uses Cloudflare's always-pass test keys from `apps/web/worker.config.ts`, `1x00000000000000000000AA` and `1x0000000000000000000000000000000AA`; they need no secret).
- The outbox is empty or you read its row count first: `scripts/probe.sh "select count(*) from outbox" --name outbox-before`.

- **Browser, both outcomes.** Run the committed spec: `scripts/drive.sh public.spec.ts -g "falsifier 3"`. Exit code `0` and `2 passed`: the first test blocks Cloudflare's script, posts, expects status 422 and the alert `Bekreft at du ikke er en robot, og prøv igjen.`, the text still in the `Melding` box, and an unchanged outbox; the second posts to the last department through its tab, waits for `[name='cf-turnstile-response']` to hold an answer, expects the URL to end in `?sendt=1`, the status text `Kontaktforespørsel sendt til <department e-mail>`, and 3 or 4 queued rows written with one timestamp.
- **Look at it.** `scripts/shot.sh /kontakt contact-form --as anonymous` writes `screenshots/contact-form.png`: the heading `Kontakt oss`, the `Velg avdeling` tabs and the fields `Ditt navn`, `Din e-post`, `Emne`, `Melding`. The spec itself writes `screenshots/public-contact-sent.png` (the receipt).
- **Stored state.** After a valid post: `scripts/probe.sh "select id, kind, status, attempts, created_at, delivered_at from outbox order by id" --name outbox-after`. New rows: kinds `Email`, `Email`, `SlackPost` (plus a second `SlackPost` when the department has a Slack channel), one `created_at` for all of them, each `delivered` with `attempts` 1. `scripts/probe.sh "select count(*) from audit_log" --name audit` is unchanged: an anonymous post is not an audited staff write.
- **Capture sink.** `grep -c "outbox message captured" <run directory>/serve.log` grows by the number of new rows; each line is `outbox message captured (non-production deployment) { kind: 'Email' }`. A body is never logged.
- **No-JS refusal.** Run `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Origin: <origin from state.env>" --data-urlencode "name=Test Besøkende" --data-urlencode "email=besokende@example.org" --data-urlencode "subject=Spørsmål" --data-urlencode "message=Hei" <origin>/kontakt/alfaby`. It prints `422` and the body holds `Bekreft at du ikke er en robot`. Without the `-H "Origin: …"` header it prints `403` (the CSRF middleware).
- **No-JS success.** Add `--data-urlencode "departmentId=1" --data-urlencode "cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX"` to the call above and print `-w '%{http_code} %{redirect_url}\n'`: `303 <origin>/kontakt/avdeling/1?sendt=1`, and the outbox grows as in the browser path. `scripts/page.sh "/kontakt/avdeling/1?sendt=1" --as anonymous` shows `301` with `location: /kontakt/alfaby?sendt=1`.
- **Proof.** `scripts/report.sh --features "contact-send, contact-refused, contact-nojs"` after the run; attach `probes/outbox-*.txt`, `screenshots/public-contact-sent.png`, the drive log and `results-<n>.json`.

## Gotchas

- Turnstile's widget is the real Cloudflare script, loaded over the network. Without outbound network the valid-post test waits 30 s for an answer and fails; that is a precondition failure, not a product failure.
- The widget is rendered explicitly when the form mounts. The department tabs are client-side navigation: after choosing a tab, wait for `Kontakt <short name>` (the new form's level-2 heading) before filling, or the old form is still on screen. Open pages with a hydration wait; the repository's `openPage` does it (`apps/web/e2e/support/panel.ts`).
- `workerd` verifies Cloudflare's TLS certificate with `SSL_CERT_FILE`, which `devenv.nix` sets in `enterShell`. Launched outside `devenv shell`, every valid post fails with `unable to get local issuer certificate`.
- The dummy token in the no-JS success call is accepted only because the instance uses Cloudflare's always-pass test secret. Never aim these commands at a deployed Preview or production.
- "Captured" means the in-process sink took the message; the log line and the `delivered` status prove the sink path. They do not prove a real mail or Slack provider works: only production builds those senders (`apps/web/test/sandbox.test.ts` is the structural proof).
- A valid post is a write: a second spec run adds more rows, so compare against `outbox-before`, never against a fixed count.
