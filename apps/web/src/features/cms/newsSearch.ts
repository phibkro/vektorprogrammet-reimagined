import { Predicate } from "effect";

interface NewsSearchInput {
  readonly avdeling?: unknown;
  readonly side?: unknown;
}

/** `avdeling` is a department's slug or short name, `side` the 1-based page; both are left out when unset. */
export interface NewsSearch {
  readonly avdeling?: string | undefined;
  readonly side?: number | undefined;
}

/** Anything else than a non-empty `avdeling` and a `side` above 1 is dropped, so the URL stays `/nyheter`. */
export const validateNewsSearch = (search: NewsSearchInput): NewsSearch => {
  const side = Number(search.side);

  return {
    avdeling:
      Predicate.isString(search.avdeling) && search.avdeling !== ""
        ? search.avdeling
        : undefined,
    side: Number.isSafeInteger(side) && side > 1 ? side : undefined,
  };
};
