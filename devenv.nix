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
  # Toolchain. Node >= 22.19 is required (root package.json engines).
  # gitleaks scans staged changes (pre-commit hook) and the full history (CI) for secrets and
  # personal data; its rules live in .gitleaks.toml. Hooks and CI resolve project tools through
  # Bun and external executables from this shell, keeping one pinned toolchain.
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.gitleaks
    playwrightBrowsers
  ];

  # Local SQL test server; the native Supabase prototype is provisioned separately.
  # This port avoids the system PostgreSQL. devenv exports PGHOST/PGPORT for this server;
  # the prototype launcher clears them before selecting its provider connection.
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
    # Defaults for local test services only. Prototype launchers select separate runtime/bootstrap
    # targets explicitly; deployed secrets are not declared here.
    DATABASE_URL = "postgres://127.0.0.1:${pgPort}/vektorprogrammet";
    MIGRATION_DATABASE_URL = "postgres://127.0.0.1:${pgPort}/vektorprogrammet";
    TEST_DATABASE_ADMIN_URL = "postgres://127.0.0.1:${pgPort}/postgres";
    LEGACY_MYSQL_URL = "mysql://legacy_reader:legacy_reader@127.0.0.1:${mysqlPort}/legacy";

    # Playwright (apps/web/e2e) uses the Nix-built browsers above and never downloads its own.
    # The host-requirements validation checks for an Ubuntu layout that Nix does not have.
    PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };

  # workerd (the Worker runtime under `vp dev`) verifies TLS against the file named by SSL_CERT_FILE. On NixOS it
  # finds no system bundle and every HTTPS `fetch` fails with "unable to get local issuer certificate": that included
  # the contact form's Turnstile verification (a POST to challenges.cloudflare.com), which the browser tests send.
  # `env` cannot carry it: Nix leaves SSL_CERT_FILE out of the environment it exports.
  enterShell = ''
    export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
  '';

  # Optional: TLA+ tools 1.7.4 (TLC) and the Java 8 runtime that nixpkgs builds them with, for the verify skills under
  # .agents/skills (a model checker, run by `.agents/skills/verify-membership-writes/run.sh`). A profile keeps them out of the
  # default shell, so CI and every other session stay as small as they are. Use `devenv shell --profile formal -- <command>`.
  # TLA2TOOLS and JAVA name the same jar and runtime for tools that take a TLC you already have. The Java heap is capped:
  # without a cap the JVM grows to a quarter of the machine's memory (a run of one million states reached 5.9 GB), and
  # the machine is shared.
  profiles.formal.module =
    { pkgs, ... }:
    {
      packages = [
        pkgs.tlaplus
        pkgs.jre8
      ];
      env = {
        JAVA = "${pkgs.jre8}/bin/java";
        JAVA_TOOL_OPTIONS = "-Xmx4g";
        TLA2TOOLS = "${pkgs.tlaplus}/share/java/tla2tools.jar";
      };
    };
}
