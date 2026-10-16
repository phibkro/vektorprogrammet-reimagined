interface ContactSearchInput {
  readonly sendt?: unknown;
}

/** The search of a contact page: `?sendt=1` marks the receipt after a post; anything else is dropped. */
export interface ContactSearch {
  readonly sendt?: 1;
}

export const validateContactSearch = (
  search: ContactSearchInput
): ContactSearch =>
  search.sendt === 1 || search.sendt === "1" ? { sendt: 1 } : {};
