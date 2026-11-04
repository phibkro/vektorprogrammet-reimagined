import { createServerFn } from "@tanstack/react-start";
import { ContentEditor } from "@vektorprogrammet/cms-client";
import { Effect, Schema } from "effect";

import { requireSection } from "../server/panelAccess";
import { liveRequestLayer, runOutcome } from "../server/runtime";
import { requestScope } from "../server/scope";

const Identity = {
  collection: Schema.Literals(["texts", "news", "sponsors", "faq", "teams"]),
  slug: Schema.String,
};

const Save = Schema.toStandardSchemaV1(
  Schema.Struct({ ...Identity, data: Schema.Json, isNew: Schema.Boolean })
);

const Publish = Schema.toStandardSchemaV1(Schema.Struct(Identity));

export const saveContent = createServerFn({ method: "POST" })
  .validator(Save)
  .handler(({ context, data }) =>
    runOutcome(
      liveRequestLayer(requestScope(context)),
      Effect.andThen(
        requireSection("content"),
        ContentEditor.use((editor) =>
          data.isNew
            ? editor.create(data.collection, data.slug, data.data)
            : editor.save(data.collection, data.slug, data.data)
        )
      ),
      requestScope(context).signal
    )
  );

export const publishContent = createServerFn({ method: "POST" })
  .validator(Publish)
  .handler(({ context, data }) =>
    runOutcome(
      liveRequestLayer(requestScope(context)),
      Effect.andThen(
        requireSection("content"),
        ContentEditor.use((editor) =>
          editor.publish(data.collection, data.slug)
        )
      ),
      requestScope(context).signal
    )
  );
