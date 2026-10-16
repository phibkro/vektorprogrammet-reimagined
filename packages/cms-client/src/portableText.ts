/**
 * The Portable Text EmDash stores for a `portableText` field, as the public site and the importer use it.
 *
 * Source of the shapes: EmDash's own components (`emdash/src/components`: `Block`, `Break`, `Code`, `HtmlBlock`,
 * `Image`, `Table`) and its admin's table type (`@emdash-cms/admin/portable-text-table`). A block whose `_type`
 * this repository does not render (embeds, galleries, columns, plugin blocks) still decodes, as `OtherBlock`, so
 * an editor's new block never fails a page; the renderer skips it.
 */
import { Schema } from "effect";

const Rest = Schema.Record(Schema.String, Schema.Unknown);

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

/** EmDash's "inline" HTML block: HTML that EmDash itself sanitizes on render. */
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
