/**
 * CMS import configuration, read from the environment only (no URL is a default, and none is ever logged):
 *
 * | Variable           | Meaning                                                                           |
 * | ------------------ | --------------------------------------------------------------------------------- |
 * | `LEGACY_MYSQL_URL` | the restored backup, read with the SELECT-only `legacy_reader`                    |
 * | `IMPORT_CMS_URL`   | the CMS origin (`apps/cms`), whose `/_emdash/api/` the import calls               |
 * | `IMPORT_CMS_TOKEN` | a personal access token with the scopes `content:read`, `content:write` and       |
 * |                    | `schema:write`, owned by an administrator (the original dates need `content:publish_any`) |
 */
import { Config } from "effect";

/** Where the entries go. The fixture import needs only this: its source is a throwaway database. */
export const CmsTargetConfig = Config.all({
  cmsToken: Config.Redacted("IMPORT_CMS_TOKEN"),
  cmsUrl: Config.NonEmptyString("IMPORT_CMS_URL"),
});

export const CmsImportConfig = Config.all({
  legacyMysqlUrl: Config.Redacted("LEGACY_MYSQL_URL"),
  target: CmsTargetConfig,
});
