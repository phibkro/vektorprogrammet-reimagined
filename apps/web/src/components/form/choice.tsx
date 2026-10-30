import { Array as Arr } from "effect";
import type { ComponentProps, ReactNode } from "react";

/** One entry of a choice: what the form holds and what the person reads. */
export interface Option {
  readonly label: string;
  readonly value: string;
}

/** Ids with names, as the pages' views give them, become the options of a choice. */
export const optionsOf = (
  rows: readonly { readonly id: number; readonly name: string }[]
): readonly Option[] =>
  Arr.map(rows, (row) => ({ label: row.name, value: String(row.id) }));

/** The value that a `<select>` shows first, which is the value a form must hold when it opens without a choice. */
export const firstValue = (options: readonly Option[]): string =>
  options[0]?.value ?? "";

const nativeSelectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * A native `<select>` over `options`: the one choice control of the panel's forms. A `Field` binds its value and its
 * change handler; `blank` is a first entry that holds nothing (an optional choice).
 */
export const Choice = ({
  blank,
  options,
  ...props
}: Omit<ComponentProps<"select">, "children"> & {
  readonly blank?: string;
  readonly options: readonly Option[];
}) => (
  <select className={nativeSelectClass} {...props}>
    {blank !== undefined && <option value="">{blank}</option>}
    {Arr.map(options, (option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);

/**
 * A set of checkboxes under one legend, as one `Field` renders it: each box is a `Field` of its own (a name of its own,
 * so a post without script carries it), and the `Field` around the set is where the messages about the whole set
 * (none chosen, one chosen twice) are shown (spec 0009).
 */
export const CheckGroup = ({ children }: { readonly children: ReactNode }) => (
  <div className="grid gap-1.5">{children}</div>
);
