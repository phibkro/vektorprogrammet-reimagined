/** What the files domain declares about its stored columns (spec 0007b): the registry of public files. */
import {
  Rules,
  columns,
  notPersonal,
  ofPerson,
  personal,
  table,
} from "../personalData/declaration.ts";
import { withThePersonCore } from "../personalData/retentions.ts";

const PUBLISHED =
  "A public file's own details: published with the file, for anyone who has its key";

const publicFile = table({
  columns: {
    ...columns(notPersonal(PUBLISHED), [
      "content_type",
      "deleted_at",
      "key",
      "legacy_path",
      "name",
      "sha256",
      "size",
      "uploaded_at",
    ]),
    uploaded_by: personal({
      legalBasis: "legitimateInterest",
      onExpiry: Rules.Anonymise.null,
      purpose: "files",
      retention: withThePersonCore,
    }),
  },
  person: ofPerson("uploaded_by", Rules.Follow),
});

export const FilesTables = { public_file: publicFile } as const;
