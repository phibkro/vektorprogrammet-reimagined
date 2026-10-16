{ pkgs, config, ... }:
let
  # The ports devenv actually allocated (the configured port is only the starting point).
  pgPort = toString config.processes.postgres.ports.main.value;
  mysqlPort = toString config.processes.mysql.ports.main.value;

  # Browsers for the Playwright tests in apps/web/e2e: Chromium only (the headless shell, the full browser and
  # ffmpeg), without Firefox and WebKit, which the tests do not use and which make the closure twice as big.
  # The npm packages `@playwright/test` and `playwright` are pinned to this derivation's Playwright version
  # (root package.json catalog), because Playwright looks for the exact browser revision it was built against
  # under PLAYWRIGHT_BROWSERS_PATH.
  playwrightBrowsers = pkgs.playwright-driver.browsers.override {
    withFirefox = false;
    withWebkit = false;
  };
in
{
  # Toolchain. Vite+ needs Node >= 22.18 (root package.json engines).
  # gitleaks scans staged changes (pre-commit hook) and the full history (CI) for secrets and
  # personal data; its rules live in .gitleaks.toml. The git hooks and CI resolve every tool
  # (vp, gitleaks, commitlint) from this shell's PATH, so they run in the same pinned toolchain.
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.gitleaks
    playwrightBrowsers
  ];

  # Local stand-in for Neon, matching its version (project bold-poetry-64036846 runs PostgreSQL 18).
  # Port 54321 avoids a system PostgreSQL on 5432. devenv exports PGHOST/PGPORT for this server:
  # unset them before using a Neon URL (Neon URLs carry no port, so libpq would dial Neon on 54321).
  # Trust auth on localhost only; no password exists for local development.
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_18;
    listen_addresses = "127.0.0.1";
    port = 54321;
    initialDatabases = [ { name = "vektorprogrammet"; } ];
  };

  # Legacy import source: the production backup is MySQL 5.7.33; mysql80 left nixpkgs, so 8.4 LTS.
  # Restoring the backup is a manual, operator-authorised step (see tools/import/README.md).
  services.mysql = {
    enable = true;
    package = pkgs.mysql84;
    settings.mysqld = {
      bind-address = "127.0.0.1";
      port = 33061;
    };
    initialDatabases = [ { name = "legacy"; } ];
    # The importer reads through a SELECT-only user (architecture critique m6). The backup restore runs as
    # the local superuser over the socket. Fixed local-only password: not a credential, never deployed.
    ensureUsers = [
      {
        name = "legacy_reader";
        password = "legacy_reader";
        ensurePermissions = {
          "legacy.*" = "SELECT";
        };
      }
    ];
  };

  env = {
    # Connection strings for local services only. Deployed environments get theirs from
    # Alchemy (Hyperdrive binding) or the import operator's shell, never from this file.
    DATABASE_URL = "postgres://127.0.0.1:${pgPort}/vektorprogrammet";
    TEST_DATABASE_ADMIN_URL = "postgres://127.0.0.1:${pgPort}/postgres";
    LEGACY_MYSQL_URL = "mysql://legacy_reader:legacy_reader@127.0.0.1:${mysqlPort}/legacy";

    # Playwright (apps/web/e2e) uses the Nix-built browsers above and never downloads its own.
    # The host-requirements validation checks for an Ubuntu layout that Nix does not have.
    PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };
}
