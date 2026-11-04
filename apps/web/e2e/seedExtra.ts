import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Record as Rec, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import publicContent from "./publicContent.json";
import { fixtureDatabaseLayer } from "./support/probes.ts";

/** Synthetic principals and public content are written only to a caller-declared disposable stack. */
const main = Effect.gen(function* seedExtra() {
  const disposable = yield* Config.String("E2E_DISPOSABLE");

  if (disposable !== "1") {
    return yield* Effect.die(new Error("E2E_DISPOSABLE=1 is required"));
  }

  const sql = yield* SqlClient;
  yield* sql`update person set email_verified = true where email in ('sofie.styre@example.org', 'eva.ekstern@example.org')`;
  yield* sql`insert into account (person_id, state) select id, 'Active' from person where email in ('sofie.styre@example.org', 'eva.ekstern@example.org') on conflict (person_id) do nothing`;

  // The public copy and FAQ fixture is extracted from the former local content seed.
  for (const [collection, entries] of Rec.toEntries(publicContent)) {
    for (const entry of entries) {
      const value = yield* Schema.decodeUnknownEffect(Schema.Json)(entry.data);

      const data = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Json)
      )(value);

      yield* sql`insert into site_content (collection, slug, draft, published, published_at) values (${collection}, ${entry.slug}, ${data}::jsonb, ${data}::jsonb, now()) on conflict (collection, slug) do update set draft = excluded.draft, published = excluded.published, published_at = excluded.published_at`;
    }
  }

  const news = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
    content: [
      {
        _key: "article",
        _type: "block",
        children: [
          {
            _key: "article-text",
            _type: "span",
            marks: [],
            text: "Opptaket er åpent for søknader.",
          },
        ],
        markDefs: [],
        style: "normal",
      },
    ],
    departments: [],
    sticky: false,
    title: "Opptak åpner",
  });

  const sponsor = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Json)
  )({ name: "Sponsor En", size: "large", url: "https://sponsor-en.example" });

  yield* sql`insert into site_content (collection, slug, draft, published, published_at) values ('news', 'opptak-apner', ${news}::jsonb, ${news}::jsonb, now()), ('sponsors', 'sponsor-en', ${sponsor}::jsonb, ${sponsor}::jsonb, now()) on conflict (collection, slug) do update set draft = excluded.draft, published = excluded.published, published_at = excluded.published_at`;
  yield* sql`insert into site_content (collection, slug, draft) values ('news', 'kladd', ${news}::jsonb), ('news', 'uten-status', ${news}::jsonb) on conflict (collection, slug) do nothing`;

  return yield* Effect.void;
});

NodeRuntime.runMain(
  Effect.gen(function* run() {
    const url = yield* Config.Redacted("DATABASE_URL");
    const target = new URL(Redacted.value(url));

    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.search ||
      target.hash
    ) {
      return yield* Effect.die(new Error("Refusing non-local fixture target"));
    }

    yield* main.pipe(Effect.provide(fixtureDatabaseLayer(url)));

    return yield* Effect.void;
  })
);
