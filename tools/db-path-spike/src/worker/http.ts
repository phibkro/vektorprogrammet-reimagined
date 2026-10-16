/**
 * Routing, parameter decoding and response encoding for the spike Worker. Every
 * handler is an Effect that answers with a `Response`: typed failures and
 * defects become a JSON error body (the smoke command prints it as evidence),
 * and an interruption stays an interruption. `worker.ts` runs them.
 */
import { Cause, Effect, Option, Record as Rec, Schema } from "effect";

import * as Protocol from "../protocol.ts";
import * as Checks from "./checks.ts";
import { requestDatabase } from "./database.ts";
import type { SpikeEnv } from "./database.ts";

/** A request the Worker cannot serve: unknown route or undecodable parameters. */
class BadRequest extends Schema.TaggedError<
  BadRequest,
  { readonly brand: unique symbol }
>()("BadRequest", {
  message: Schema.String,
}) {}

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
};

const MAX_MESSAGE_LENGTH = 600;

const failureBody = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error) && Schema.is(BadRequest)(error.value)) {
    return {
      kind: "bad-request" as const,
      status: 400,
      text: error.value.message,
    };
  }

  return Option.isSome(error)
    ? {
        kind: "typed" as const,
        status: 500,
        text: Cause.pretty(cause),
      }
    : { kind: "defect" as const, status: 500, text: Cause.pretty(cause) };
};

const refuse = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.gen(function* refusal() {
        const body = failureBody(cause);

        if (body.status >= 500) {
          yield* Effect.logError("check failed", body.text);
        }

        return Response.json(
          {
            error: {
              kind: body.kind,
              message: body.text.slice(0, MAX_MESSAGE_LENGTH),
            },
          } satisfies typeof Protocol.ErrorBody.Type,
          { headers: jsonHeaders, status: body.status }
        );
      });

/** Encodes `program`'s value with `schema` into a 200 response. */
const answer =
  <A>(schema: Schema.Codec<A>) =>
  <E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(schema))),
      Effect.map((body) => new Response(body, { headers: jsonHeaders })),
      Effect.catchCause(refuse)
    );

/** Decodes the query string (untrusted text) with `schema`, then runs `use`; undecodable parameters are a `BadRequest`. */
export const withParams = <P, A, E, R>(
  schema: Schema.Decoder<P>,
  url: URL,
  use: (params: P) => Effect.Effect<A, E, R>
) => {
  const query: unknown = Rec.fromEntries(url.searchParams);

  return Schema.decodeUnknownEffect(schema)(query).pipe(
    Effect.mapError((error) => new BadRequest({ message: error.message })),
    Effect.flatMap(use)
  );
};

const withDatabase = (env: SpikeEnv) => Effect.provide(requestDatabase(env));

/** The host of the Worker's only database address (`<id>.hyperdrive.local` behind Hyperdrive). */
const hyperdriveHost = (env: SpikeEnv) =>
  new URL(env.HYPERDRIVE.connectionString).hostname;

type Handler = (url: URL, env: SpikeEnv) => Effect.Effect<Response>;

const handlers = {
  [`POST ${Protocol.routes.abortProbe}`]: (url, env) =>
    answer(Protocol.AbortProbe)(
      withParams(Protocol.RunParams, url, ({ run }) =>
        Checks.abortProbe(run)
      ).pipe(withDatabase(env))
    ),
  [`POST ${Protocol.routes.bcrypt}`]: (url) =>
    answer(Protocol.Bcrypt)(
      withParams(Protocol.BcryptParams, url, ({ which }) =>
        Checks.verifyBcrypt(which)
      )
    ),
  [`POST ${Protocol.routes.cache}`]: (url, env) =>
    answer(Protocol.Cache)(
      withParams(Protocol.CacheParams, url, ({ from, run }) =>
        Checks.cache(run, from)
      ).pipe(withDatabase(env))
    ),
  [`POST ${Protocol.routes.codec}`]: (url, env) =>
    answer(Protocol.Codec)(
      withParams(Protocol.RunParams, url, ({ run }) => Checks.codec(run)).pipe(
        withDatabase(env)
      )
    ),
  [`POST ${Protocol.routes.commit}`]: (url, env) =>
    answer(Protocol.Committed)(
      withParams(Protocol.RunParams, url, ({ run }) => Checks.commit(run)).pipe(
        withDatabase(env)
      )
    ),
  [`GET ${Protocol.routes.connect}`]: (_url, env) =>
    answer(Protocol.Connect)(
      Checks.connect({
        hyperdriveHost: hyperdriveHost(env),
        workerVersion: env.CF_VERSION_METADATA.id,
      }).pipe(withDatabase(env))
    ),
  [`GET ${Protocol.routes.ping}`]: () =>
    answer(Protocol.Ping)(Effect.succeed({ ok: true })),
  [`POST ${Protocol.routes.rollbackTyped}`]: (url, env) =>
    answer(Protocol.RolledBack)(
      withParams(Protocol.RunParams, url, ({ run }) =>
        Checks.rollbackTyped(run)
      ).pipe(withDatabase(env))
    ),
  [`GET ${Protocol.routes.rows}`]: (url, env) =>
    answer(Protocol.Rows)(
      withParams(Protocol.RunParams, url, ({ run }) => Checks.rows(run)).pipe(
        withDatabase(env)
      )
    ),
  [`GET ${Protocol.routes.sanitize}`]: () =>
    answer(Protocol.Sanitize)(Effect.sync(Checks.sanitize)),
  [`POST ${Protocol.routes.savepoint}`]: (url, env) =>
    answer(Protocol.RolledBack)(
      withParams(Protocol.RunParams, url, ({ run }) =>
        Checks.savepoint(run)
      ).pipe(withDatabase(env))
    ),
  [`GET ${Protocol.routes.semesters}`]: (url, env) =>
    answer(Protocol.Semesters)(
      withParams(Protocol.SemesterParams, url, ({ term, year }) =>
        Checks.semesters(term, year)
      ).pipe(withDatabase(env))
    ),
  [`POST ${Protocol.routes.unique}`]: (url, env) =>
    answer(Protocol.Unique)(
      withParams(Protocol.SemesterParams, url, ({ term, year }) =>
        Checks.unique(term, year)
      ).pipe(withDatabase(env))
    ),
  [`POST ${Protocol.routes.upsert}`]: (url, env) =>
    answer(Protocol.Upserted)(
      withParams(Protocol.UpsertParams, url, (params) =>
        Checks.upsert(params)
      ).pipe(withDatabase(env))
    ),
} satisfies Record<string, Handler>;

/** The Effect that answers one request (everything except the streaming `abort` route, see `worker.ts`). */
export const route = (
  request: Request,
  env: SpikeEnv
): Effect.Effect<Response> => {
  const url = new URL(request.url);

  return Option.match(Rec.get(handlers, `${request.method} ${url.pathname}`), {
    onNone: () =>
      refuse(
        Cause.fail(
          new BadRequest({
            message: `no route for ${request.method} ${url.pathname}`,
          })
        )
      ),
    onSome: (handler) => handler(url, env),
  });
};
