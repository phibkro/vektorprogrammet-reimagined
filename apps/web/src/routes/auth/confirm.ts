import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { createRequestClient } from "../../adapters/supabase/clients";

const recoveryResponse = (token: string | null, type: string | null) => {
  if (token === null || token === "" || type !== "recovery") {
    return new Response("Invalid link", {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
      status: 400,
    });
  }

  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: `/tilbakestill-passord?token_hash=${encodeURIComponent(token)}`,
      "Referrer-Policy": "no-referrer",
    },
    status: 303,
  });
};

export const Route = createFileRoute("/auth/confirm")({
  server: {
    handlers: {
      GET: ({ request, context }) =>
        Effect.runPromise(
          Effect.gen(function* confirm() {
            const url = new URL(request.url);
            const flow = url.searchParams.get("flow");
            const type = url.searchParams.get("type");
            const token = url.searchParams.get("token_hash");
            const code = url.searchParams.get("code");

            const kind = flow ?? type;

            if (kind !== "invite" && kind !== "recovery") {
              return new Response("Invalid link", { status: 400 });
            }

            if (kind === "recovery") {
              return recoveryResponse(token, type);
            }

            const client = createRequestClient(context.env);

            let result = null;

            if (token !== null && token !== "" && type === kind) {
              result = yield* Effect.promise(() =>
                client.auth.verifyOtp({ token_hash: token, type: kind })
              );
            } else if (code !== null && code !== "") {
              result = yield* Effect.promise(() =>
                client.auth.exchangeCodeForSession(code)
              );
            }

            if (result === null || result.error !== null) {
              return new Response("Invalid or expired link", { status: 400 });
            }

            return new Response(null, {
              headers: { Location: "/aktiver" },
              status: 303,
            });
          })
        ),
    },
  },
});
