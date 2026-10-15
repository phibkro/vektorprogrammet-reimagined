/**
 * `/filer/{key}` (RULE-290 replacement): only registered keys are served
 * (`servePublicFile`). The domain's `servingHeaders` is the single source of
 * the header policy (inline only for JPEG/PNG/WebP/GIF/PDF, otherwise
 * `attachment`; always `nosniff`, a sandbox CSP and an immutable cache
 * lifetime); this module only turns the outcome into a `Response`.
 */
import { servingHeaders } from "@vektorprogrammet/domain";
import { Stream } from "effect";
import type { Outcome } from "../lib/outcome";

export interface PublicFileResult {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array>;
}

/** Error responses carry the same anti-sniffing headers, taken from the domain policy. */
const policy = servingHeaders({ name: "error", contentType: "application/octet-stream", size: 0 });
const ERROR_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": policy["X-Content-Type-Options"],
  "Content-Security-Policy": policy["Content-Security-Policy"],
  "Cache-Control": "no-store",
};

export const publicFileResponse = (
  outcome: Outcome<PublicFileResult>,
  method: string,
): Response => {
  const withBody = method !== "HEAD";
  if (outcome._tag === "Failure") {
    return new Response(withBody ? outcome.message : null, {
      status: outcome.status,
      headers: ERROR_HEADERS,
    });
  }
  const { headers, body } = outcome.value;
  return new Response(withBody ? Stream.toReadableStream(body) : null, { status: 200, headers });
};
