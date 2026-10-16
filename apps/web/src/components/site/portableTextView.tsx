/**
 * Renders the Portable Text an editor wrote in the CMS (`@portabletext/react`, Sanity's renderer, MIT) in the
 * look of mono-web's pages. Block styles, lists, marks and links, and the block types EmDash adds that the
 * public pages show: `table`, `code`, `break`, `image`. Another block type (an embed, a gallery, raw HTML) is
 * skipped, so an editor's new block never breaks a page and raw HTML never reaches the browser.
 *
 * A link is rendered only for `http`, `https`, `mailto`, `tel` and site-relative addresses; any other `href`
 * (for example `javascript:`) is shown as plain text.
 */
import { PortableText } from "@portabletext/react";
import type {
  PortableTextComponents,
  PortableTextMarkComponentProps,
  PortableTextTypeComponentProps,
} from "@portabletext/react";
import type { PortableText as Cms } from "@vektorprogrammet/cms-client";
import { Array as Arr, Option, Schema } from "effect";

import { cn } from "@/lib/utils";

/** Whether the text sits on the white page or on the dark band (`.info-background`). */
export type Tone = "light" | "dark";

const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/iu;

/** An annotation's `href` is JSON of any shape; only a string can be a link. */
const parseHref = Schema.decodeUnknownOption(Schema.String);

/** The address of a link mark when it is one the page may link to. */
export const safeHref = (href: string): Option.Option<string> =>
  SAFE_HREF.test(href.trim()) ? Option.some(href.trim()) : Option.none();

const headingColor = (tone: Tone) =>
  tone === "dark" ? "text-vektor-bg" : "text-vektor-DARKblue";

const Link = ({
  children,
  value,
}: PortableTextMarkComponentProps<{
  readonly _type: string;
  readonly href?: unknown;
}>) =>
  Option.match(Option.flatMap(parseHref(value?.href), safeHref), {
    onNone: () => <>{children}</>,
    onSome: (href) => (
      <a
        className="underline underline-offset-2 hover:no-underline"
        href={href}
        {...(href.startsWith("http")
          ? { rel: "noopener noreferrer", target: "_blank" }
          : {})}
      >
        {children}
      </a>
    ),
  });

/** The marks of a text and of a table cell: the same rule decides which link is one. */
const MARKS: PortableTextComponents["marks"] = {
  code: ({ children }) => (
    <code className="bg-vektor-code text-vektor-ink rounded px-1 font-mono text-sm">
      {children}
    </code>
  ),
  link: Link,
  underline: ({ children }) => <u>{children}</u>,
};

/** One table cell: its spans and link definitions as the one inline block they are. */
const CellText = ({ cell }: { readonly cell: Cms.TableCell }) => (
  <PortableText
    value={[
      {
        _type: "block",
        children: Arr.fromIterable(cell.content),
        markDefs: Arr.fromIterable(cell.markDefs ?? []),
        style: "normal",
      },
    ]}
    components={{
      block: { normal: ({ children }) => <>{children}</> },
      marks: MARKS,
    }}
    onMissingComponent={false}
  />
);

const Table = ({ value }: PortableTextTypeComponentProps<Cms.TableBlock>) => (
  <div className="my-6 overflow-x-auto">
    <table className="w-full border-collapse text-left">
      <tbody>
        {Arr.map(value.rows, (row, rowIndex) => (
          <tr key={row._key ?? rowIndex}>
            {Arr.map(row.cells, (cell, cellIndex) => {
              const Cell = cell.isHeader === true ? "th" : "td";

              return (
                <Cell
                  className={cn(
                    "border-vektor-blue border px-3 py-2 align-top",
                    cell.isHeader === true &&
                      "bg-vektor-light-blue font-semibold"
                  )}
                  colSpan={cell.colspan}
                  key={cell._key ?? cellIndex}
                  rowSpan={cell.rowspan}
                >
                  <CellText cell={cell} />
                </Cell>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const componentsFor = (tone: Tone): PortableTextComponents => ({
  block: {
    blockquote: ({ children }) => (
      <blockquote className="border-vektor-blue my-4 border-l-4 pl-4 italic">
        {children}
      </blockquote>
    ),
    h1: ({ children }) => (
      <h1
        className={cn(
          "mb-3 text-center text-2xl font-bold md:text-4xl",
          headingColor(tone)
        )}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={cn(
          "mb-3 text-center text-2xl font-bold md:text-3xl",
          headingColor(tone)
        )}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3
        className={cn("mb-2 text-xl font-bold md:text-2xl", headingColor(tone))}
      >
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className={cn("mb-2 text-lg font-bold", headingColor(tone))}>
        {children}
      </h4>
    ),
    normal: ({ children }) => (
      <p className="mb-4 max-w-3xl text-base leading-relaxed whitespace-pre-line last:mb-0 md:text-lg">
        {children}
      </p>
    ),
  },
  list: {
    bullet: ({ children }) => (
      <ul className="mb-4 ml-5 list-disc text-base leading-relaxed md:text-lg">
        {children}
      </ul>
    ),
    number: ({ children }) => (
      <ol className="mb-4 ml-5 list-decimal text-base leading-relaxed md:text-lg">
        {children}
      </ol>
    ),
  },
  listItem: { bullet: ({ children }) => <li className="py-1">{children}</li> },
  marks: MARKS,
  types: {
    break: () => <hr className="border-vektor-blue my-8" />,
    code: ({ value }: PortableTextTypeComponentProps<Cms.CodeBlock>) => (
      <pre className="bg-vektor-code text-vektor-ink my-4 overflow-x-auto rounded p-3 text-sm">
        <code>{value.code}</code>
      </pre>
    ),
    image: ({ value }: PortableTextTypeComponentProps<Cms.ImageBlock>) =>
      value.asset.url === undefined ? null : (
        <figure className="my-6">
          <img
            alt={value.alt ?? ""}
            className="mx-auto max-h-96 rounded-lg"
            src={value.asset.url}
          />
          {value.caption === undefined ? null : (
            <figcaption className="mt-2 text-center text-sm">
              {value.caption}
            </figcaption>
          )}
        </figure>
      ),
    table: Table,
  },
});

const LIGHT = componentsFor("light");

const DARK = componentsFor("dark");

/** A text slot of a page; renders nothing when the CMS has no published text for it. */
export const PortableTextView = ({
  className,
  tone = "light",
  value,
}: {
  readonly value: readonly Cms.PortableTextBlock[] | null;
  readonly tone?: Tone;
  readonly className?: string;
}) =>
  value === null || value.length === 0 ? null : (
    <div className={cn(tone === "dark" && "text-vektor-bg", className)}>
      <PortableText
        components={tone === "dark" ? DARK : LIGHT}
        onMissingComponent={false}
        value={Arr.fromIterable(value)}
      />
    </div>
  );
