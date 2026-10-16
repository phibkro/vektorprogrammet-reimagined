/**
 * Public surface of `@vektorprogrammet/cms-client`: the typed EmDash content client (`CmsClient`), the collection
 * schemas and Portable Text. `src/generated.ts` is generated and stays private to the package.
 */
export {
  CmsClient,
  CmsInvalidContent,
  CmsRejected,
  CmsUnavailable,
  CreateOutcome,
  layer,
} from "./client.ts";

export type {
  CmsConfig,
  CmsFailure,
  Collection,
  Entry,
  Listing,
  NewEntry,
} from "./client.ts";

export {
  COLLECTIONS,
  FaqData,
  FaqPage,
  ImageValue,
  NewsData,
  SponsorData,
  SponsorSize,
  TeamData,
  TextData,
} from "./collections.ts";

export type { CollectionName } from "./collections.ts";

export * as PortableText from "./portableText.ts";
