import {
  ClientOnly,
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { FaqPage, ImageValue, SponsorSize } from "@vektorprogrammet/cms-client";
import type {
  CollectionName,
  ContentDraft,
} from "@vektorprogrammet/cms-client";
import {
  Array as Arr,
  Effect,
  Option,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";
import { lazy, Suspense, useState } from "react";

import { PageHeader } from "@/components/panel/pageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publishContent, saveContent } from "@/functions/content.functions";
import { getContent } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

// The editor SDK initializes browser-only random keys when its module loads.
const ContentTextEditor = lazy(() =>
  import("@/components/panel/contentTextEditor").then((module) => ({
    default: module.ContentTextEditor,
  }))
);

const editorLoading = <p role="status">Laster tekstredigering …</p>;

const collections: Readonly<Record<CollectionName, string>> = {
  faq: "Spørsmål og svar",
  news: "Nyheter",
  sponsors: "Sponsorer",
  teams: "Team",
  texts: "Tekster",
};

const isCollection = Schema.is(
  Schema.Literals(["texts", "news", "sponsors", "faq", "teams"])
);

const fields: Readonly<
  Record<CollectionName, readonly [string, string, string][]>
> = {
  faq: [
    ["question", "Spørsmål", "text"],
    ["answer", "Svar", "textarea"],
    ["page", "Side (assistenter eller team)", "text"],
    ["position", "Rekkefølge", "number"],
  ],
  news: [
    ["title", "Tittel", "text"],
    ["departments", "Avdelinger (kommadelt)", "list"],
  ],
  sponsors: [
    ["name", "Navn", "text"],
    ["url", "Nettadresse", "url"],
    ["size", "Størrelse (small, medium, large)", "text"],
  ],
  teams: [
    ["name", "Navn", "text"],
    ["department", "Avdeling", "text"],
    ["description", "Beskrivelse", "textarea"],
    ["email", "E-post", "email"],
    ["position", "Rekkefølge", "number"],
  ],
  texts: [["title", "Tittel", "text"]],
};

const defaults: Readonly<Record<CollectionName, Record<string, Schema.Json>>> =
  {
    faq: { answer: "", page: "assistenter", position: 0, question: "" },
    news: { content: [], departments: [], sticky: false, title: "" },
    sponsors: { name: "", size: "medium", url: "" },
    teams: {
      department: "",
      description: "",
      email: "",
      name: "",
      position: 0,
    },
    texts: { content: [], title: "" },
  };

const decodeRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Json)
);

const isImage = Schema.is(ImageValue);

const fieldText = (type: string, value: Schema.Json | undefined): string => {
  if (type === "list" && Schema.is(Schema.Array(Schema.String))(value)) {
    return Arr.join(value, ", ");
  }

  if (Schema.is(Schema.String)(value)) {
    return value;
  }

  if (Schema.is(Schema.Finite)(value)) {
    return String(value);
  }

  return "";
};

const routeApi = getRouteApi("/kontrollpanel/innhold");

interface Draft {
  collection: CollectionName;
  slug: string;
  data: Record<string, Schema.Json>;
  published: boolean;
  isNew: boolean;
}

const fromEntry = (entry: ContentDraft): Draft => ({
  collection: entry.collection,
  data: Option.getOrThrow(decodeRecord(entry.draft)),
  isNew: false,
  published: entry.published !== null,
  slug: entry.slug,
});

const Editor = ({
  initial,
  onClose,
}: {
  initial: Draft;
  onClose: () => void;
}) => {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(initial.isNew);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const setField = (name: string, value: Schema.Json) => {
    setDraft((current) => ({
      ...current,
      data: { ...current.data, [name]: value },
    }));
    setDirty(true);
    setNotice("");
  };

  const save = () => {
    if (!draft.slug.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.slug)) {
      setNotice("Nøkkelen må inneholde små bokstaver, tall og bindestrek.");

      return;
    }

    setBusy(true);
    Effect.gen(function* saveDraft() {
      const result = yield* Effect.tryPromise(() =>
        saveContent({
          data: {
            collection: draft.collection,
            data: draft.data,
            isNew: draft.isNew,
            slug: draft.slug,
          },
        })
      );

      if (Predicate.isTagged(result, "Failure")) {
        setNotice(
          Predicate.isTagged(result.error, "CmsRejected") &&
            result.error.code === "SLUG_CONFLICT"
            ? "Nøkkelen er allerede i bruk. Velg en annen nøkkel."
            : result.message
        );

        return;
      }

      setDraft((current) => ({ ...current, isNew: false }));
      setDirty(false);
      setNotice("Utkastet er lagret. Det er ikke publisert.");
      yield* Effect.tryPromise(() => router.invalidate());
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          setNotice(
            "Kunne ikke lagre utkastet. Kontroller feltene og prøv igjen."
          );
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          setBusy(false);
        })
      ),
      Effect.runFork
    );
  };

  const publish = () => {
    setBusy(true);
    Effect.gen(function* publishDraft() {
      const result = yield* Effect.tryPromise(() =>
        publishContent({
          data: { collection: draft.collection, slug: draft.slug },
        })
      );

      if (Predicate.isTagged(result, "Failure")) {
        setNotice(result.message);

        return;
      }

      setDraft((current) => ({ ...current, published: true }));
      setNotice("Utkastet er publisert.");
      yield* Effect.tryPromise(() => router.invalidate());
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          setNotice("Kunne ikke publisere. Prøv igjen.");
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          setBusy(false);
        })
      ),
      Effect.runFork
    );
  };

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">
        Rediger {collections[draft.collection].toLowerCase()}
      </h2>
      <label className="block space-y-1">
        Nøkkel{" "}
        <Input
          value={draft.slug}
          disabled={!draft.isNew}
          onChange={(event) => {
            setDraft({ ...draft, slug: event.target.value });
            setDirty(true);
          }}
        />
      </label>
      {Arr.map(fields[draft.collection], ([name, label, type]) => {
        const value = draft.data[name];

        const text = fieldText(type, value);

        const change = (next: string) => {
          if (type === "number") {
            setField(name, Number(next));

            return;
          }

          if (type === "list") {
            setField(
              name,
              Arr.filter(
                Arr.map(next.split(","), (item) => item.trim()),
                (item) => item.length > 0
              )
            );

            return;
          }

          setField(name, next);
        };

        if (name === "size" || name === "page") {
          const schema = name === "size" ? SponsorSize : FaqPage;

          return (
            <label key={name} className="block space-y-1">
              {label}
              <select
                value={text}
                onChange={(event) => {
                  if (
                    Arr.some(
                      schema.literals,
                      (option) => option === event.target.value
                    )
                  ) {
                    change(event.target.value);
                  }
                }}
                className="border-input block rounded border p-2"
              >
                {Arr.map(schema.literals, (option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        return (
          <label key={name} className="block space-y-1">
            {label}
            {type === "textarea" ? (
              <textarea
                className="border-input min-h-24 w-full rounded-md border p-2"
                value={text}
                onChange={(event) => {
                  change(event.target.value);
                }}
              />
            ) : (
              <Input
                type={type === "list" ? "text" : type}
                value={text}
                onChange={(event) => {
                  change(event.target.value);
                }}
              />
            )}
          </label>
        );
      })}
      {(draft.collection === "news" || draft.collection === "sponsors") &&
        (() => {
          const key = draft.collection === "news" ? "image" : "logo";
          const previous = draft.data[key];
          const image = isImage(previous) ? previous : null;

          return (
            <label className="block space-y-1">
              Bildeadresse{" "}
              <Input
                type="url"
                value={image?.src ?? ""}
                onChange={(event) => {
                  setField(
                    key,
                    event.target.value
                      ? {
                          id: event.target.value,
                          src: event.target.value,
                        }
                      : null
                  );
                }}
              />
            </label>
          );
        })()}
      {draft.collection === "news" && (
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={Boolean(draft.data.sticky)}
            onChange={(event) => {
              setField("sticky", event.target.checked);
            }}
          />{" "}
          Fremhev nyheten
        </label>
      )}
      {(draft.collection === "texts" || draft.collection === "news") && (
        <ClientOnly fallback={editorLoading}>
          <Suspense fallback={editorLoading}>
            <ContentTextEditor
              value={draft.data.content}
              onChange={(value) => {
                setField("content", value);
              }}
            />
          </Suspense>
        </ClientOnly>
      )}
      <p className="text-sm">
        {draft.published
          ? "Har en publisert versjon. Endringer vises først etter publisering."
          : "Ikke publisert."}
      </p>
      {notice && <p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || !dirty} onClick={save}>
          Lagre utkast
        </Button>
        <Button
          type="button"
          disabled={busy || dirty || draft.isNew}
          onClick={publish}
        >
          Publiser lagret utkast
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Lukk
        </Button>
      </div>
    </section>
  );
};

const ContentPage = () => {
  const entries = routeApi.useLoaderData();
  const [collection, setCollection] = useState<CollectionName>("texts");
  const [selected, setSelected] = useState<Draft | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nettsideinnhold"
        description="Rediger utkast og publiser når innholdet er klart."
      />
      <label className="block">
        Samling{" "}
        <select
          value={collection}
          onChange={(event) => {
            if (isCollection(event.target.value)) {
              setCollection(event.target.value);
              setSelected(null);
            }
          }}
          className="border-input ml-2 rounded border p-2"
        >
          {Arr.map(Rec.toEntries(collections), ([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setSelected({
            collection,
            data: { ...defaults[collection] },
            isNew: true,
            published: false,
            slug: "",
          });
        }}
      >
        Nytt innhold
      </Button>
      <ul className="space-y-2">
        {Arr.map(
          Arr.filter(entries, (entry) => entry.collection === collection),
          (entry) => (
            <li
              key={entry.slug}
              className="flex items-center justify-between rounded border p-3"
            >
              <span>
                {entry.slug}{" "}
                {entry.published === null ? "(utkast)" : "(publisert)"}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSelected(fromEntry(entry));
                }}
              >
                Rediger
              </Button>
            </li>
          )
        )}
      </ul>
      {selected && (
        <Editor
          key={`${selected.collection}:${selected.slug}`}
          initial={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </div>
  );
};

export const Route = createFileRoute("/kontrollpanel/innhold")({
  component: ContentPage,
  loader: () => getContent().then(pageData),
});
