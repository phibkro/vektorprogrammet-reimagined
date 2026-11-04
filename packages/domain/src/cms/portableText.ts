/** Portable Text used by the public site and importer. Unknown blocks decode and are skipped by the renderer. */
import { Schema } from "effect";

/** What an annotation or an unknown block carries besides its type: JSON, so a page can hand it to the browser. */
const Rest = Schema.Record(Schema.String, Schema.Json);

export const Span = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("span"),
  marks: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.String,
});

export type Span = typeof Span.Type;

/** A mark definition: a link has an `href`, other annotations carry their own fields. */
export const MarkDefinition = Schema.StructWithRest(
  Schema.Struct({ _key: Schema.String, _type: Schema.String }),
  [Rest]
);

export type MarkDefinition = typeof MarkDefinition.Type;

export const TextBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("block"),
  children: Schema.Array(Span),
  level: Schema.optionalKey(Schema.Int),
  listItem: Schema.optionalKey(Schema.Literals(["bullet", "number"])),
  markDefs: Schema.optionalKey(Schema.Array(MarkDefinition)),
  style: Schema.optionalKey(Schema.String),
});

export type TextBlock = typeof TextBlock.Type;

export const CodeBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("code"),
  code: Schema.String,
  language: Schema.optionalKey(Schema.String),
});

export type CodeBlock = typeof CodeBlock.Type;

export const BreakBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("break"),
  style: Schema.optionalKey(Schema.String),
});

export type BreakBlock = typeof BreakBlock.Type;

/** An inline HTML block; renderers must sanitize its HTML. */
export const HtmlBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("htmlBlock"),
  html: Schema.String,
});

export type HtmlBlock = typeof HtmlBlock.Type;

export const TableCell = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.optionalKey(Schema.Literal("tableCell")),
  colspan: Schema.optionalKey(Schema.Int),
  content: Schema.Array(Span),
  isHeader: Schema.optionalKey(Schema.Boolean),
  markDefs: Schema.optionalKey(Schema.Array(MarkDefinition)),
  rowspan: Schema.optionalKey(Schema.Int),
});

export type TableCell = typeof TableCell.Type;

export const TableRow = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.optionalKey(Schema.Literal("tableRow")),
  cells: Schema.Array(TableCell),
});

export type TableRow = typeof TableRow.Type;

export const TableBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("table"),
  hasHeaderRow: Schema.optionalKey(Schema.Boolean),
  markDefs: Schema.optionalKey(Schema.Array(MarkDefinition)),
  rows: Schema.Array(TableRow),
});

export type TableBlock = typeof TableBlock.Type;

export const ImageBlock = Schema.Struct({
  _key: Schema.optionalKey(Schema.String),
  _type: Schema.Literal("image"),
  alt: Schema.optionalKey(Schema.String),
  asset: Schema.Struct({
    _ref: Schema.String,
    url: Schema.optionalKey(Schema.String),
  }),
  caption: Schema.optionalKey(Schema.String),
});

export type ImageBlock = typeof ImageBlock.Type;

export const OtherBlock = Schema.StructWithRest(
  Schema.Struct({ _type: Schema.String }),
  [Rest]
);

export type OtherBlock = typeof OtherBlock.Type;

export const PortableTextBlock = Schema.Union([
  TextBlock,
  CodeBlock,
  BreakBlock,
  HtmlBlock,
  TableBlock,
  ImageBlock,
  OtherBlock,
]);

export type PortableTextBlock = typeof PortableTextBlock.Type;

export const PortableText = Schema.Array(PortableTextBlock);

export type PortableText = typeof PortableText.Type;
