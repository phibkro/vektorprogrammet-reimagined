/**
 * `GET /api/isolation` (spec 0018, falsifier 4, the deployed path): the isolation level that a domain transaction runs at,
 * read inside `Transactor.run` as the store reports it. A Worker Preview reaches its database through Hyperdrive, so what
 * this answers there is what the platform does with the explicit `BEGIN ISOLATION LEVEL READ COMMITTED` that
 * `transactional` sends; `.github/workflows/preview.yml` calls it on every pull request and fails unless it says
 * `read committed`. It reads one setting and writes nothing, and a production Worker has no such route: the answer is
 * `None` there, and the route's reply is a 404.
 */
import { Transactor } from "@vektorprogrammet/domain";
import { Effect, Option, Predicate } from "effect";
import { SqlClient } from "effect/sql";

import type { Outcome } from "../lib/outcome";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./env";

/** The level of a domain transaction, or `None` on a production deployment. */
export const transactionIsolation = (setting: WorkerEnv["DEPLOYMENT"]) =>
  Effect.gen(function* isolationOfATransaction() {
    const deployment = yield* decodeDeployment(setting);

    if (deployment === "production") {
      return Option.none<string>();
    }

    const transactor = yield* Transactor;
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* transactor
      .run(
        sql<{
          readonly level: string;
        }>`select current_setting('transaction_isolation') as level`
      )
      .pipe(Effect.orDie);

    return Option.fromNullishOr(rows[0]?.level);
  });

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
} satisfies Readonly<Record<string, string>>;

/** The level as the body of a 200; a 404 on production; the failure's own status otherwise. */
export const isolationResponse = (outcome: Outcome<Option.Option<string>>) => {
  if (Predicate.isTagged(outcome, "Failure")) {
    return new Response(outcome.message, {
      headers: HEADERS,
      status: outcome.status,
    });
  }

  return Option.match(outcome.value, {
    onNone: () => new Response(null, { headers: HEADERS, status: 404 }),
    onSome: (level) => new Response(level, { headers: HEADERS, status: 200 }),
  });
};
