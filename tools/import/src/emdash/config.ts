import { Config } from "effect";

export const CmsTargetConfig = Config.all({
  databaseUrl: Config.Redacted("DATABASE_URL"),
});

export const CmsImportConfig = Config.all({
  legacyMysqlUrl: Config.Redacted("LEGACY_MYSQL_URL"),
  target: CmsTargetConfig,
});
