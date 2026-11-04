import {
  defineDecorator,
  defineTextBlock,
  defineSchema,
  EditorProvider,
  PortableTextEditable,
  useEditor,
} from "@portabletext/editor";
import { EventListenerPlugin, NodePlugin } from "@portabletext/editor/plugins";
import { Array as Arr, Option, Schema } from "effect";

import { Button } from "@/components/ui/button";

const editorSchema = defineSchema({
  annotations: [{ fields: [{ name: "href", type: "string" }], name: "link" }],
  blockObjects: [],
  decorators: [{ name: "strong" }, { name: "em" }, { name: "underline" }],
  inlineObjects: [],
  lists: [{ name: "bullet" }, { name: "number" }],
  styles: [
    { name: "normal" },
    { name: "h1" },
    { name: "h2" },
    { name: "h3" },
    { name: "blockquote" },
  ],
});

const EditableBlocks = Schema.Array(
  Schema.Struct({
    _key: Schema.String,
    _type: Schema.Literal("block"),
    children: Schema.Array(
      Schema.Struct({
        _key: Schema.String,
        _type: Schema.Literal("span"),
        marks: Schema.optionalKey(Schema.Array(Schema.String)),
        text: Schema.String,
      })
    ),
    level: Schema.optionalKey(Schema.Int),
    listItem: Schema.optionalKey(Schema.Literals(["bullet", "number"])),
    markDefs: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          _key: Schema.String,
          _type: Schema.Literal("link"),
          href: Schema.String,
        })
      )
    ),
    style: Schema.optionalKey(
      Schema.Literals(["normal", "h1", "h2", "h3", "blockquote"])
    ),
  })
);

const isEditable = Schema.is(EditableBlocks);

const nodes = [
  defineTextBlock({
    render: (props) => <div {...props.attributes}>{props.children}</div>,
    type: "block",
  }),
  defineDecorator({
    render: ({ children }) => <strong>{children}</strong>,
    type: "strong",
  }),
  defineDecorator({
    render: ({ children }) => <em>{children}</em>,
    type: "em",
  }),
  defineDecorator({
    render: ({ children }) => <u>{children}</u>,
    type: "underline",
  }),
];

const TextToolbar = () => {
  const editor = useEditor();

  return (
    <div className="flex flex-wrap gap-2" aria-label="Tekstformatering">
      {Arr.map(
        [
          ["strong", "Fet"],
          ["em", "Kursiv"],
          ["underline", "Understrek"],
        ],
        ([decorator, label]) => (
          <Button
            key={decorator}
            type="button"
            variant="outline"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              editor.send({ decorator, type: "decorator.toggle" });
              editor.send({ type: "focus" });
            }}
          >
            {label}
          </Button>
        )
      )}
      {Arr.map(
        [
          ["normal", "Avsnitt"],
          ["h2", "Overskrift"],
          ["blockquote", "Sitat"],
        ],
        ([style, label]) => (
          <Button
            key={style}
            type="button"
            variant="outline"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              editor.send({ style, type: "style.toggle" });
              editor.send({ type: "focus" });
            }}
          >
            {label}
          </Button>
        )
      )}
    </div>
  );
};

export const ContentTextEditor = ({
  value,
  onChange,
}: {
  value: Schema.Json | undefined;
  onChange: (value: Schema.Json) => void;
}) => {
  const initial = value ?? [];

  if (!isEditable(initial)) {
    return (
      <p role="alert">
        Denne teksten inneholder blokker som ikke kan redigeres her. Innholdet
        beholdes uendret når du lagrer de andre feltene.
      </p>
    );
  }

  const blocks = Arr.map(initial, (block) => ({
    ...block,
    children: Arr.map(block.children, (span) => ({
      ...span,
      marks: [...(span.marks ?? [])],
    })),
    markDefs: [...(block.markDefs ?? [])],
  }));

  return (
    <div className="space-y-2">
      <h3 className="font-medium">Innhold</h3>
      <EditorProvider
        initialConfig={{ initialValue: blocks, schemaDefinition: editorSchema }}
      >
        <EventListenerPlugin
          on={(event) => {
            if (event.type === "mutation") {
              const parsed = Schema.decodeUnknownOption(Schema.Json)(
                event.value ?? []
              );

              if (Option.isSome(parsed)) {
                onChange(parsed.value);
              }
            }
          }}
        />
        <TextToolbar />
        <NodePlugin nodes={nodes} />
        <PortableTextEditable
          aria-label="Innhold"
          className="border-input min-h-40 rounded-md border p-3"
        />
      </EditorProvider>
    </div>
  );
};
