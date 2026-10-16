/**
 * Legacy rich text to the Portable Text EmDash stores.
 *
 * The input is HTML that already went through the domain sanitizer, so it holds only the allowlist's tags
 * (`packages/domain/src/content/sanitizer.ts`): paragraphs, h2-h4, marks, links, lists, blockquote, pre, hr,
 * figure, table, img. The output shapes are the ones EmDash's own editor writes
 * (`emdash/src/content/converters/prosemirror-to-portable-text.ts`): `block` (style, `listItem` + `level` for list
 * items, `markDefs` for links), `code`, `break`, `table`.
 *
 * Images are dropped and counted. The legacy files are not copied (file migration is not authorised yet), so an
 * image has nothing to point at; a figure keeps its caption as a paragraph.
 *
 * Pure and deterministic: keys are `k1`, `k2`, … in document order, so the same HTML gives the same value.
 */
import type { PortableText } from "@vektorprogrammet/cms-client";
import { isTag, isText } from "domhandler";
import type { ChildNode, Element } from "domhandler";
import { Array as Arr, HashMap, Option, Record as Rec } from "effect";
import { DomUtils, parseDocument } from "htmlparser2";

/** The blocks this converter writes; each is a member of `PortableText.PortableTextBlock`. */
export type Block =
  | PortableText.BreakBlock
  | PortableText.CodeBlock
  | PortableText.TableBlock
  | PortableText.TextBlock;

type Span = PortableText.Span;

type MarkDefinition = PortableText.MarkDefinition;

export interface PortableTextConversion {
  readonly blocks: readonly Block[];
  /** `<img>` elements that were dropped. */
  readonly imagesDropped: number;
}

/** Inline elements that are a mark; `a` is handled on its own because it needs a definition. */
const MARK_OF = HashMap.fromIterable<string, string>([
  ["b", "strong"],
  ["code", "code"],
  ["em", "em"],
  ["i", "em"],
  ["s", "strike-through"],
  ["strong", "strong"],
  ["sub", "subscript"],
  ["sup", "superscript"],
  ["u", "underline"],
]);

const STYLE_OF = HashMap.fromIterable<string, string>([
  ["h2", "h2"],
  ["h3", "h3"],
  ["h4", "h4"],
  ["p", "normal"],
]);

/** Elements that start a new block when they sit among inline content. */
const BLOCK_NAMES = [
  "blockquote",
  "figure",
  "h2",
  "h3",
  "h4",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
];

/** Elements that end a line of text when they are flattened into inline content (a table cell). */
const LINE_NAMES = [
  "blockquote",
  "figcaption",
  "figure",
  "h2",
  "h3",
  "h4",
  "li",
  "p",
  "pre",
];

/** How a text block sits in the document: its style, and its list kind and depth when it is a list item. */
interface Context {
  readonly style: string;
  readonly list?: {
    readonly kind: "bullet" | "number";
    readonly level: number;
  };
}

interface Inline {
  readonly spans: Span[];
  readonly markDefs: MarkDefinition[];
}

const sameMarkList = Arr.makeEquivalence((a: string, b: string) => a === b);

const collapse = (text: string) => text.replaceAll(/\s+/gu, " ");

const elementsNamed = (nodes: readonly ChildNode[], names: readonly string[]) =>
  Arr.filter(
    nodes,
    (node): node is Element => isTag(node) && Arr.contains(names, node.name)
  );

/** Merges neighbours with the same marks, drops spaces that follow a space or a line break, trims both ends. */
const tidy = (spans: readonly Span[]): readonly Span[] => {
  const merged: Span[] = [];

  for (const span of spans) {
    const previous = merged.at(-1);

    const startsLine =
      previous === undefined ||
      previous.text.endsWith(" ") ||
      previous.text.endsWith("\n");

    const text = startsLine ? span.text.replace(/^ +/u, "") : span.text;

    if (
      previous !== undefined &&
      sameMarkList(previous.marks ?? [], span.marks ?? [])
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text + text };
    } else if (text !== "") {
      merged.push({ ...span, text });
    }
  }

  return Arr.filter(
    Arr.map(merged, (span, index) =>
      index === merged.length - 1
        ? { ...span, text: span.text.replace(/ +$/u, "") }
        : span
    ),
    (span) => span.text !== ""
  );
};

/** A `colspan` or `rowspan` attribute, 1 when absent or not a count above 1. */
const spanAttribute = (element: Element, name: string): number =>
  Rec.get(element.attribs, name).pipe(
    Option.map(Number),
    Option.filter((count) => Number.isSafeInteger(count) && count > 1),
    Option.getOrElse(() => 1)
  );

/** Converts one sanitized HTML fragment. */
export const htmlToPortableText = (html: string): PortableTextConversion => {
  let counter = 0;
  let imagesDropped = 0;

  const nextKey = () => {
    counter += 1;

    return `k${counter}`;
  };

  const spanOf = (text: string, marks: readonly string[]): Span => ({
    _key: nextKey(),
    _type: "span",
    marks,
    text,
  });

  /** One inline element. `recurse` is `inlineOf`, passed in so the two do not refer to each other. */
  const inlineElement = (
    element: Element,
    marks: readonly string[],
    into: Inline,
    recurse: (
      nodes: readonly ChildNode[],
      marks: readonly string[],
      into: Inline
    ) => void
  ): void => {
    if (element.name === "br") {
      into.spans.push(spanOf("\n", []));

      return;
    }

    if (element.name === "img") {
      imagesDropped += 1;

      return;
    }

    const link = Option.map(
      element.name === "a" ? Rec.get(element.attribs, "href") : Option.none(),
      (href): MarkDefinition => ({ _key: nextKey(), _type: "link", href })
    );

    if (Option.isSome(link)) {
      into.markDefs.push(link.value);
    }

    const added = Option.match(link, {
      onNone: () => HashMap.get(MARK_OF, element.name),
      onSome: (definition) => Option.some(definition._key),
    });

    recurse(
      element.children,
      Option.match(added, {
        onNone: () => marks,
        onSome: (mark) => Arr.append(marks, mark),
      }),
      into
    );

    if (Arr.contains(LINE_NAMES, element.name)) {
      into.spans.push(spanOf(" ", []));
    }
  };

  /** Flattens `nodes` into spans and link definitions, carrying the marks of the elements around them. */
  const inlineOf = (
    nodes: readonly ChildNode[],
    marks: readonly string[],
    into: Inline
  ): void => {
    for (const node of nodes) {
      if (isText(node)) {
        into.spans.push(spanOf(collapse(node.data), marks));
      } else if (isTag(node)) {
        inlineElement(node, marks, into, inlineOf);
      }
    }
  };

  const inlineContent = (nodes: readonly ChildNode[]) => {
    const into: Inline = { markDefs: [], spans: [] };
    inlineOf(nodes, [], into);

    return { markDefs: into.markDefs, spans: tidy(into.spans) };
  };

  /** A text block, or nothing when the content is blank. */
  const textBlock = (
    nodes: readonly ChildNode[],
    context: Context
  ): readonly Block[] => {
    const { markDefs, spans } = inlineContent(nodes);

    if (spans.length === 0) {
      return [];
    }

    const block = {
      _key: nextKey(),
      _type: "block" as const,
      children: spans,
      markDefs,
      style: context.style,
    };

    return [
      context.list === undefined
        ? block
        : { ...block, level: context.list.level, listItem: context.list.kind },
    ];
  };

  const tableBlock = (table: Element): readonly Block[] => {
    const rowElements = Arr.flatMap(table.children, (child) =>
      isTag(child) && child.name === "tr"
        ? [child]
        : Arr.flatMap(
            elementsNamed([child], ["thead", "tbody", "tfoot"]),
            (section) => elementsNamed(section.children, ["tr"])
          )
    );

    const rows = Arr.map(rowElements, (row) => ({
      _key: nextKey(),
      cells: Arr.map(elementsNamed(row.children, ["td", "th"]), (cell) => {
        const { markDefs, spans } = inlineContent(cell.children);

        return {
          _key: nextKey(),
          colspan: spanAttribute(cell, "colspan"),
          content: spans,
          isHeader: cell.name === "th",
          markDefs,
          rowspan: spanAttribute(cell, "rowspan"),
        };
      }),
    }));

    const [caption] = elementsNamed(table.children, ["caption"]);
    const [first] = rows;

    const captionBlocks =
      caption === undefined
        ? []
        : textBlock(caption.children, { style: "normal" });

    return rows.length === 0
      ? captionBlocks
      : [
          ...captionBlocks,
          {
            _key: nextKey(),
            _type: "table" as const,
            hasHeaderRow:
              first !== undefined &&
              first.cells.length > 0 &&
              Arr.every(first.cells, (cell) => cell.isHeader),
            rows,
          },
        ];
  };

  /** One block element. `recurse` is `blocksOf`, passed in so the two do not refer to each other. */
  const blockElement = (
    element: Element,
    context: Context,
    recurse: (nodes: readonly ChildNode[], context: Context) => readonly Block[]
  ): readonly Block[] => {
    const style = HashMap.get(STYLE_OF, element.name);

    if (Option.isSome(style)) {
      return textBlock(element.children, {
        ...context,
        style: element.name === "p" ? context.style : style.value,
      });
    }

    switch (element.name) {
      case "blockquote": {
        return recurse(element.children, { style: "blockquote" });
      }

      case "pre": {
        return [
          {
            _key: nextKey(),
            _type: "code",
            code: DomUtils.textContent(element).replaceAll(/^\n|\n$/gu, ""),
          },
        ];
      }

      case "hr": {
        return [{ _key: nextKey(), _type: "break", style: "lineBreak" }];
      }

      case "ul":
      case "ol": {
        const list = {
          kind:
            element.name === "ol" ? ("number" as const) : ("bullet" as const),
          level: (context.list?.level ?? 0) + 1,
        };

        return Arr.flatMap(elementsNamed(element.children, ["li"]), (item) =>
          recurse(item.children, { list, style: "normal" })
        );
      }

      case "figure": {
        return Arr.flatMap(element.children, (child) => {
          if (isTag(child) && child.name === "img") {
            imagesDropped += 1;

            return [];
          }

          return isTag(child) && child.name === "figcaption"
            ? textBlock(child.children, { style: "normal" })
            : recurse([child], { style: "normal" });
        });
      }

      case "table": {
        return tableBlock(element);
      }

      default: {
        // A stray list item: its text is still content.
        return textBlock(element.children, context);
      }
    }
  };

  /** Block elements become blocks; the inline content between them becomes text blocks of `context`. */
  const blocksOf = (
    nodes: readonly ChildNode[],
    context: Context
  ): readonly Block[] => {
    const blocks: Block[] = [];
    let run: ChildNode[] = [];

    const flush = () => {
      blocks.push(...textBlock(run, context));
      run = [];
    };

    for (const node of nodes) {
      if (isTag(node) && Arr.contains(BLOCK_NAMES, node.name)) {
        flush();
        blocks.push(...blockElement(node, context, blocksOf));
      } else {
        run.push(node);
      }
    }

    flush();

    return blocks;
  };

  const blocks = blocksOf(parseDocument(html).children, { style: "normal" });

  return { blocks, imagesDropped };
};
