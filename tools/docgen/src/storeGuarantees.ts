/**
 * The generated blocks of `docs/system/store-guarantees.md` (spec 0018): the guarantees as the domain declares them, what it
 * does not promise, and the transaction mode of every port method. Pure, like the other renderers: the declaration goes in,
 * the page comes out, and the check compares it with the committed one.
 */
import {
  NonGuarantees,
  StoreGuarantees,
  TransactionModes,
} from "@vektorprogrammet/domain";
import type {
  Carrier,
  Guarantee,
  NonGuarantee,
  TransactionMode,
} from "@vektorprogrammet/domain";
import { Array as Arr, Record as Rec } from "effect";
import type { Result } from "effect";

import { checkRendered, replaceBlocks, table } from "./render.ts";

/** What the page is made of: the real declarations, or changed ones in the tests that show a changed declaration changes it. */
export interface StoreDeclarations {
  readonly guarantees: readonly Guarantee[];
  readonly nonGuarantees: readonly NonGuarantee[];
  readonly modes: Readonly<
    Record<string, Readonly<Record<string, TransactionMode>>>
  >;
}

export const STORE: StoreDeclarations = {
  guarantees: StoreGuarantees,
  modes: TransactionModes,
  nonGuarantees: NonGuarantees,
};

const MODES: readonly TransactionMode[] = [
  "Requires",
  "Standalone",
  "Joins",
  "Read",
  "Outside",
  "Opens",
];

/** The last name of a service key: `@vektorprogrammet/domain/shared/Outbox` is `Outbox`. */
const portName = (key: string): string => key.split("/").at(-1) ?? key;

const carrierLabel = (carrier: Carrier): string =>
  carrier.method === null
    ? `\`${portName(carrier.port)}\``
    : `\`${portName(carrier.port)}.${carrier.method}\``;

const strengthCell = (guarantee: Guarantee): string =>
  guarantee.exception === undefined
    ? guarantee.strength
    : `${guarantee.strength}; exception: ${guarantee.exception.reason} (recovery: ${guarantee.exception.recovery})`;

const guaranteeRow = (guarantee: Guarantee): readonly string[] => [
  guarantee.id,
  guarantee.property,
  strengthCell(guarantee),
  guarantee.invariant ? "yes" : "no",
  Arr.join(Arr.map(guarantee.carriers, carrierLabel), ", "),
  guarantee.rawWriter,
];

const guarantees = (declared: readonly Guarantee[]): string =>
  Arr.join(
    Arr.map(
      Arr.dedupe(Arr.map(declared, (guarantee) => guarantee.capability)),
      (capability) =>
        `### ${capability}\n\n${table(
          [
            "Id",
            "Property",
            "Strength",
            "Invariant",
            "Carriers",
            "A raw writer",
          ],
          Arr.map(
            Arr.filter(
              declared,
              (guarantee) => guarantee.capability === capability
            ),
            guaranteeRow
          )
        )}`
    ),
    "\n\n"
  );

const nonGuarantees = (declared: readonly NonGuarantee[]): string =>
  table(
    ["Id", "Not promised", "Where"],
    Arr.map(declared, (promise) => [
      promise.id,
      promise.statement,
      Arr.join(Arr.map(promise.carriers, carrierLabel), ", "),
    ])
  );

const modes = (declared: StoreDeclarations["modes"]): string =>
  table(
    ["Port", ...MODES],
    Arr.map(Rec.toEntries(declared), ([port, methods]) => [
      `\`${port}\``,
      ...Arr.map(MODES, (mode) =>
        Arr.join(
          Arr.map(
            Arr.filter(Rec.toEntries(methods), ([, value]) => value === mode),
            ([method]) => `\`${method}\``
          ),
          ", "
        )
      ),
    ])
  );

export const renderStoreGuaranteesDocument = (
  document: string,
  declared: StoreDeclarations = STORE
): Result.Result<string, string> =>
  replaceBlocks(document, [
    ["guarantees", guarantees(declared.guarantees)],
    ["non-guarantees", nonGuarantees(declared.nonGuarantees)],
    ["modes", modes(declared.modes)],
  ]);

export const checkStoreGuaranteesDocument = (
  document: string,
  declared: StoreDeclarations = STORE
): Result.Result<void, string> =>
  checkRendered(document, renderStoreGuaranteesDocument(document, declared));
